// What flash.concurrent's Mutex and Condition, and the player's message
// queues, share between workers (docs/workers.md): one heap of int32
// words that every thread of a primordial's sees, a SharedArrayBuffer
// where memory can be shared, so that a Mutex or a queue crosses to another
// worker as an address and is there at once, with no memory to post after
// it. A thread blocks with Atomics.wait where it can; a browser's main
// thread cannot, and spins instead, up to Flash's script timeout.
//
// A worker may be stopped anywhere, so nothing here waits for ever on a
// worker that has ended: a lock held by one is taken over by the next
// thread that wants it, as avmplus lets go of the Mutexes a terminated
// worker held, and a notify passes over the waiters that have ended.

/** The memory every thread of a primordial's shares, plain data a structured clone carries. */
export interface SyncMemory {
  /** The heap: its header, then blocks, each a power of two words. */
  heap: SharedArrayBuffer | ArrayBuffer;
  /** Two words a thread, by its worker's number: whether it is blocked in a wait, and whether it runs or has ended. */
  threads: SharedArrayBuffer | ArrayBuffer;
}

/** How a runtime takes part: the memory, and the worker it runs. */
export interface SyncInit {
  memory: SyncMemory;
  /** Its worker's number, 0 being the primordial. */
  thread: number;
  /**
   * Spin rather than block even where the thread could, as a browser's
   * main thread must: for tests of the spinning path.
   */
  spin?: boolean;
  /** How long a spinning lock or wait may take before it fails, in milliseconds: Flash's 15 s by default. */
  timeout?: number;
}

/** Flash's script timeout, which a primordial that blocks too long hits. */
export const SCRIPT_TIMEOUT = 15000;

// The heap's header: its lock, the next free word, and a free list for
// each block size, 2^k words.
const HEAP_LOCK = 0;
const HEAP_NEXT = 1;
const BINS = 2;
const MAX_CLASS = 28;
/** The next worker's number, for workers any thread makes. */
const NEXT_THREAD = BINS + MAX_CLASS + 1;
/** The address of the queue of requests for the primordial, which it takes even while it waits. */
const REQUESTS = NEXT_THREAD + 1;
// A table every thread reads, the player's workers' shared properties: its
// lock, the block that holds its bytes (their length, then them), its
// version, and the last token given out.
const TABLE_LOCK = REQUESTS + 1;
const TABLE = TABLE_LOCK + 1;
const TABLE_VERSION = TABLE + 1;
const TABLE_TOKEN = TABLE_VERSION + 1;
const HEADER = TABLE_TOKEN + 1;
/** A block's own words before what it holds: its size class. */
const BLOCK_HEAD = 2;
const HEAP_MAX = 1 << 30;
const THREADS_MAX = 1 << 20;

/** A thread's state in its table: 0 before it runs, then RUNNING, then ENDED. */
const RUNNING = 2;
const ENDED = 1;

/** How long a blocked thread sleeps before it looks again whether a lock's holder has ended. */
const CHUNK = 50;

// A thread's record: its park word, its next in a condition's queue, its
// worker's number, and its next in a mutex's queue. The park word is
// WAITING in a condition's wait, until a notify picks it or it times out.
const PARK = 0;
const C_NEXT = 1;
const OWNER = 2;
const M_NEXT = 3;
const WAITING = 0;
const NOTIFIED = 1;
const TIMED_OUT = 2;

// A mutex: its holder plus one (0 when free), how many times it holds it,
// the queue of the threads waiting for it, first and last, and the
// queue's lock.
const HOLDER = 0;
const COUNT = 1;
const M_HEAD = 2;
const M_TAIL = 3;
const M_LOCK = 4;

// A condition: its mutex, and its queue of waiting threads' records.
const MUTEX = 0;
const HEAD = 1;
const TAIL = 2;

// A queue: its lock, how many entries it holds, its first and last, and
// whether it was closed. An entry: the next, its length in bytes, its bytes.
const Q_LOCK = 0;
const Q_COUNT = 1;
const Q_HEAD = 2;
const Q_TAIL = 3;
const Q_CLOSED = 4;

interface Growable {
  readonly byteLength: number;
  grow?(length: number): void;
  resize?(length: number): void;
}

type GrowableConstructor = new (
  length: number,
  options: { maxByteLength: number },
) => ArrayBuffer | SharedArrayBuffer;

/** Growable memory, shared where it can be, as much as the host reserves up to `max`. */
function growable(length: number, max: number, shared: boolean): ArrayBuffer | SharedArrayBuffer {
  const ctor = (shared ? SharedArrayBuffer : ArrayBuffer) as unknown as GrowableConstructor;
  for (;;) {
    try {
      return new ctor(length, { maxByteLength: max });
    } catch (e) {
      if (max <= length * 2) {
        throw e;
      }

      max /= 2;
    }
  }
}

/** `buffer` made at least `length` bytes; false where it cannot grow so far. */
function grow(buffer: ArrayBuffer | SharedArrayBuffer, length: number): boolean {
  const b = buffer as unknown as Growable;
  while (b.byteLength < length) {
    try {
      if (b.grow) {
        b.grow(length);
      } else {
        b.resize?.(length);
      }
    } catch {
      // Another thread grew it meanwhile, to as much or more, or it cannot grow.
      return b.byteLength >= length;
    }
  }

  return true;
}

/** Whether this thread can share memory: SharedArrayBuffer is there, and a page is cross-origin isolated. */
function canShare(): boolean {
  const g = globalThis as { crossOriginIsolated?: boolean };
  return typeof SharedArrayBuffer === "function" && g.crossOriginIsolated !== false;
}

/** New memory for a primordial's workers: shared where it can be, else this thread's alone. */
export function newSyncMemory(): SyncMemory {
  const shared = canShare();
  const heap = growable(1 << 16, HEAP_MAX, shared);
  const words = new Int32Array(heap);
  words[HEAP_NEXT] = HEADER;
  words[NEXT_THREAD] = 1;
  return { heap, threads: growable(64, THREADS_MAX, shared) };
}

let threadCanWait: boolean | null = null;

/** Whether this thread may Atomics.wait: a browser's main thread may not. */
function canWaitHere(): boolean {
  if (threadCanWait === null) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
      threadCanWait = true;
    } catch {
      threadCanWait = false;
    }
  }

  return threadCanWait;
}

/** A lock or wait that spun for longer than the script timeout. */
export class SyncTimeout extends Error {
  constructor() {
    super("swf2es: a lock or wait took longer than the script timeout");
  }
}

/** The shared heap as one thread sees it. */
export class Sync {
  readonly words: Int32Array;
  readonly bytes: Uint8Array;
  private readonly threads: Int32Array;
  /** Whether other threads see this memory: else nothing else can take a lock or notify. */
  readonly shared: boolean;
  /** Whether this thread blocks in Atomics.wait, or spins. */
  readonly waits: boolean;
  readonly timeout: number;
  private record = 0;
  /** See spinningSince. */
  private spinning: number | null = null;
  /**
   * What this thread does whenever it waits, between waits of no more
   * than a few milliseconds: the primordial takes its requests then, as
   * a background worker that asks for a worker may be what it waits for.
   */
  poll: (() => void) | null = null;

  constructor(
    readonly memory: SyncMemory,
    readonly thread: number,
    options: { spin?: boolean; timeout?: number } = {},
  ) {
    this.words = new Int32Array(memory.heap);
    this.bytes = new Uint8Array(memory.heap);
    this.threads = new Int32Array(memory.threads);
    this.shared =
      typeof SharedArrayBuffer === "function" && memory.heap instanceof SharedArrayBuffer;
    this.waits = this.shared && !options.spin && canWaitHere();
    this.timeout = options.timeout ?? SCRIPT_TIMEOUT;
    this.addThread(thread);
  }

  /** A number for a new worker, unique among the primordial's whichever thread makes it, with room in the threads' table. */
  newThread(): number {
    const id = Atomics.add(this.words, NEXT_THREAD, 1);
    this.addThread(id);
    return id;
  }

  /** The shared table's version, which every change moves on. */
  tableVersion(): number {
    return Atomics.load(this.words, TABLE_VERSION);
  }

  /** The shared table's bytes, and their version. */
  readTable(): { version: number; bytes: Uint8Array } {
    this.acquire(TABLE_LOCK, Date.now());
    try {
      return { version: this.tableVersion(), bytes: this.tableBytes() };
    } finally {
      this.release(TABLE_LOCK);
    }
  }

  /** Replace the shared table's bytes with what `f` makes of them, in one step every thread sees. */
  updateTable(f: (bytes: Uint8Array) => Uint8Array): void {
    this.acquire(TABLE_LOCK, Date.now());
    try {
      const bytes = f(this.tableBytes());
      const block = this.alloc(1 + Math.ceil(bytes.length / 4));
      this.words[block] = bytes.length;
      this.bytes.set(bytes, (block + 1) * 4);
      const old = Atomics.exchange(this.words, TABLE, block);
      Atomics.add(this.words, TABLE_VERSION, 1);
      if (old !== 0) {
        this.free(old);
      }
    } finally {
      this.release(TABLE_LOCK);
    }
  }

  /** A number never given out before, for an entry of the table. */
  nextToken(): number {
    return Atomics.add(this.words, TABLE_TOKEN, 1) + 1;
  }

  private tableBytes(): Uint8Array {
    const block = Atomics.load(this.words, TABLE);
    if (block === 0) {
      return new Uint8Array(0);
    }

    const at = (block + 1) * 4;
    return this.bytes.slice(at, at + this.words[block]);
  }

  /** The primordial's queue of requests, once it has made it; 0 before. */
  get requests(): number {
    return Atomics.load(this.words, REQUESTS);
  }

  set requests(q: number) {
    Atomics.store(this.words, REQUESTS, q);
  }

  /** Make room for worker `id` in the threads' table, before it starts. */
  addThread(id: number): void {
    grow(this.memory.threads, (id + 1) * 8);
  }

  /** Whether worker `id` has not ended. */
  alive(id: number): boolean {
    if (id < 0) {
      return false;
    }

    return 2 * id + 1 >= this.threads.length || Atomics.load(this.threads, 2 * id + 1) !== ENDED;
  }

  /** Whether worker `id` has started and not ended, as its own thread says. */
  running(id: number): boolean {
    return 2 * id + 1 < this.threads.length && Atomics.load(this.threads, 2 * id + 1) === RUNNING;
  }

  /** Worker `id`, this thread's, runs; unless it has ended already. */
  start(id: number): void {
    this.addThread(id);
    Atomics.compareExchange(this.threads, 2 * id + 1, 0, RUNNING);
  }

  /** Worker `id` has ended: the locks it held are free to take, and no notify picks it. */
  end(id: number): void {
    this.addThread(id);
    Atomics.store(this.threads, 2 * id + 1, ENDED);
  }

  /** A block of at least `n` words, zeroed: the address of its first. */
  alloc(n: number): number {
    let k = 2;
    while (1 << k < n + BLOCK_HEAD) {
      k++;
    }

    if (k > MAX_CLASS) {
      throw new RangeError("swf2es: a block larger than the shared heap");
    }

    const words = this.words;
    this.acquire(HEAP_LOCK, Date.now());
    let block: number;
    try {
      block = Atomics.load(words, BINS + k);
      if (block !== 0) {
        Atomics.store(words, BINS + k, Atomics.load(words, block + 1));
      } else {
        block = Atomics.load(words, HEAP_NEXT);
        if (!grow(this.memory.heap, (block + (1 << k)) * 4)) {
          throw new RangeError("swf2es: the shared heap is full");
        }

        Atomics.store(words, HEAP_NEXT, block + (1 << k));
      }
    } finally {
      this.release(HEAP_LOCK);
    }

    words.fill(0, block, block + (1 << k));
    words[block] = k;
    return block + BLOCK_HEAD;
  }

  free(address: number): void {
    const block = address - BLOCK_HEAD;
    const k = this.words[block];
    this.acquire(HEAP_LOCK, Date.now());
    try {
      Atomics.store(this.words, block + 1, Atomics.load(this.words, BINS + k));
      Atomics.store(this.words, BINS + k, block);
    } finally {
      this.release(HEAP_LOCK);
    }
  }

  /**
   * Take the lock in word `index`, which holds its holder's number plus
   * one; from a holder that has ended, at once. `start` is when the
   * operation began, for the script timeout of a thread that spins.
   */
  acquire(index: number, start: number): void {
    const me = this.thread + 1;
    for (;;) {
      const holder = Atomics.compareExchange(this.words, index, 0, me);
      if (holder === 0) {
        return;
      }

      if (
        !this.alive(holder - 1) &&
        Atomics.compareExchange(this.words, index, holder, me) === holder
      ) {
        return;
      }

      this.park(index, holder, CHUNK, start);
    }
  }

  /** Take the lock in word `index` if it is free, or its holder has ended. */
  tryAcquire(index: number): boolean {
    const me = this.thread + 1;
    const holder = Atomics.compareExchange(this.words, index, 0, me);
    return (
      holder === 0 ||
      (!this.alive(holder - 1) && Atomics.compareExchange(this.words, index, holder, me) === holder)
    );
  }

  release(index: number): void {
    Atomics.store(this.words, index, 0);
    Atomics.notify(this.words, index, 1);
  }

  /**
   * Wait up to `ms` while word `index` holds `value`: Atomics.wait where
   * this thread can, else spinning on it with a backoff that never sleeps,
   * failing with SyncTimeout once this thread has spun for longer than the
   * script timeout without returning to its event loop, as Flash times a
   * script out: content that waits a millisecond at a time in a loop, as
   * Crossbridge's startup does, is stopped too. Where there is no event
   * loop to tell, from `start`, when the operation began.
   */
  park(index: number, value: number, ms: number, start: number): void {
    this.poll?.();
    Atomics.store(this.threads, 2 * this.thread, 1);
    try {
      this.spinOrWait(index, value, ms, start);
    } finally {
      Atomics.store(this.threads, 2 * this.thread, 0);
    }
  }

  /** Whether worker `id` is blocked in a lock or a wait now. */
  blocked(id: number): boolean {
    return 2 * id < this.threads.length && Atomics.load(this.threads, 2 * id) !== 0;
  }

  private spinOrWait(index: number, value: number, ms: number, start: number): void {
    if (this.waits) {
      Atomics.wait(this.words, index, value, ms);
      return;
    }

    const since = this.spinningSince(start);
    const end = Date.now() + ms;
    let spins = 1;
    for (;;) {
      if (Atomics.load(this.words, index) !== value) {
        return;
      }

      const now = Date.now();
      if (now - since > this.timeout) {
        throw new SyncTimeout();
      }

      if (now >= end) {
        return;
      }

      for (let i = 0; i < spins; i++) {
        // A pause between loads, longer each time, up to a few microseconds.
      }

      spins = Math.min(spins * 2, 4096);
    }
  }

  /** When this thread began to spin since it last returned to its event loop. */
  private spinningSince(start: number): number {
    if (this.spinning === null) {
      const later = (globalThis as { setTimeout?: (f: () => void, ms: number) => unknown })
        .setTimeout;
      if (!later) {
        return start;
      }

      this.spinning = Date.now();
      // A task of its own, which runs only once the thread is back in its event loop.
      later(() => {
        this.spinning = null;
      }, 0);
    }

    return this.spinning;
  }

  newMutex(): number {
    return this.alloc(5);
  }

  /** Whether this thread holds the mutex at `m`. */
  holds(m: number): boolean {
    return Atomics.load(this.words, m + HOLDER) === this.thread + 1;
  }

  /**
   * As avmplus' MutexObject::lock: held again by its holder, or taken in
   * the order the threads came for it. A thread that ended leaves the
   * queue to the next, and the mutex if it held it.
   */
  lock(m: number): void {
    if (this.holds(m)) {
      this.words[m + COUNT]++;
      return;
    }

    const start = Date.now();
    if (Atomics.load(this.words, m + M_HEAD) !== 0 || !this.tryAcquire(m + HOLDER)) {
      this.enqueue(m, this.ownRecord());
      this.timed(() => this.takeTurn(m, start));
    }

    this.words[m + COUNT] = 1;
  }

  /** As MutexObject::tryLock: never while another thread waits for it, as avmplus' hasWaiters. */
  tryLock(m: number): boolean {
    if (this.waiter(m) !== 0) {
      return false;
    }

    if (this.holds(m)) {
      this.words[m + COUNT]++;
      return true;
    }

    if (!this.tryAcquire(m + HOLDER)) {
      return false;
    }

    this.words[m + COUNT] = 1;
    return true;
  }

  /** Whether this thread held it, once less now. */
  unlock(m: number): boolean {
    if (!this.holds(m)) {
      return false;
    }

    if (--this.words[m + COUNT] === 0) {
      Atomics.store(this.words, m + HOLDER, 0);
      // The first in its queue takes it; the others look again whether they are first.
      Atomics.notify(this.words, m + HOLDER);
    }

    return true;
  }

  /** Add record `r` at the end of the queue of the threads waiting for mutex `m`. */
  private enqueue(m: number, r: number): void {
    const words = this.words;
    Atomics.store(words, r + M_NEXT, 0);
    this.acquire(m + M_LOCK, Date.now());
    try {
      const tail = Atomics.load(words, m + M_TAIL);
      if (tail === 0) {
        Atomics.store(words, m + M_HEAD, r);
      } else {
        Atomics.store(words, tail + M_NEXT, r);
      }

      Atomics.store(words, m + M_TAIL, r);
    } finally {
      this.release(m + M_LOCK);
    }
  }

  /** The first thread waiting for mutex `m` that has not ended, those that ended taken out; 0 for none. */
  private waiter(m: number): number {
    const words = this.words;
    for (;;) {
      const head = Atomics.load(words, m + M_HEAD);
      if (head === 0 || this.alive(Atomics.load(words, head + OWNER))) {
        return head;
      }

      this.dequeue(m, head);
    }
  }

  /** Take record `r` from the head of mutex `m`'s queue, if it is still there. */
  private dequeue(m: number, r: number): void {
    const words = this.words;
    this.acquire(m + M_LOCK, Date.now());
    try {
      if (Atomics.load(words, m + M_HEAD) !== r) {
        return;
      }

      const next = Atomics.load(words, r + M_NEXT);
      Atomics.store(words, m + M_HEAD, next);
      if (next === 0) {
        Atomics.store(words, m + M_TAIL, 0);
      }
    } finally {
      this.release(m + M_LOCK);
    }
  }

  /** Wait, this thread's record in mutex `m`'s queue, until it is first and takes the mutex. */
  private takeTurn(m: number, start: number): void {
    const r = this.record;
    for (;;) {
      if (this.waiter(m) === r && this.tryAcquire(m + HOLDER)) {
        this.dequeue(m, r);
        return;
      }

      const holder = Atomics.load(this.words, m + HOLDER);
      this.park(m + HOLDER, holder, holder === 0 ? 1 : CHUNK, start);
    }
  }

  newCondition(m: number): number {
    const c = this.alloc(3);
    Atomics.store(this.words, c + MUTEX, m);
    return c;
  }

  conditionMutex(c: number): number {
    return Atomics.load(this.words, c + MUTEX);
  }

  /**
   * As avmplus' ConditionObject::wait, its mutex held by this thread: the
   * mutex let go, however many times it was held, until a notify picks
   * this thread or `ms` have passed (never, for -1), then held again as
   * it was. A notify picks the waiters in the order they came, and they
   * take the mutex again in that order. Whether the time ran out.
   */
  wait(c: number, ms: number): boolean {
    const words = this.words;
    const m = this.conditionMutex(c);
    const r = this.ownRecord();
    const start = Date.now();
    Atomics.store(words, r + PARK, WAITING);
    Atomics.store(words, r + C_NEXT, 0);
    const tail = Atomics.load(words, c + TAIL);
    if (tail === 0) {
      Atomics.store(words, c + HEAD, r);
    } else {
      Atomics.store(words, tail + C_NEXT, r);
    }

    Atomics.store(words, c + TAIL, r);

    const count = words[m + COUNT];
    words[m + COUNT] = 1;
    // As often as it was held, once now.
    this.unlock(m);

    const end = ms < 0 ? Number.POSITIVE_INFINITY : start + ms;
    let timedOut = false;
    this.timed(() => {
      for (;;) {
        if (Atomics.load(words, r + PARK) === NOTIFIED) {
          break;
        }

        const left = end - Date.now();
        if (left <= 0 && Atomics.compareExchange(words, r + PARK, WAITING, TIMED_OUT) === WAITING) {
          // Left in the condition's queue, which a notify passes over, until
          // this thread holds the mutex again and takes it out.
          timedOut = true;
          this.enqueue(m, r);
          break;
        }

        this.park(r + PARK, WAITING, Math.max(Math.min(left, CHUNK), 0), start);
      }

      // A notify put the record in the mutex's queue, in the order it picked it.
      this.takeTurn(m, start);
    });
    words[m + COUNT] = count;
    if (timedOut) {
      this.unqueue(c, r);
    }

    return timedOut;
  }

  /**
   * Pick the first waiter that has not ended or timed out, or all of them,
   * the mutex held by this thread: each moves to the mutex's queue, to take
   * it in turn once this thread lets go of it.
   */
  notify(c: number, all: boolean): void {
    const words = this.words;
    const m = this.conditionMutex(c);
    for (;;) {
      const r = Atomics.load(words, c + HEAD);
      if (r === 0) {
        return;
      }

      const next = Atomics.load(words, r + C_NEXT);
      Atomics.store(words, c + HEAD, next);
      if (next === 0) {
        Atomics.store(words, c + TAIL, 0);
      }

      // One whose wait timed out meanwhile has queued itself for the mutex.
      if (
        this.alive(Atomics.load(words, r + OWNER)) &&
        Atomics.compareExchange(words, r + PARK, WAITING, NOTIFIED) === WAITING
      ) {
        this.enqueue(m, r);
        Atomics.notify(words, r + PARK);
        if (!all) {
          return;
        }
      }
    }
  }

  /**
   * Run `f`, which may leave this thread's record in a queue: one it
   * leaves for the script timeout is given up, its owner none, so that
   * the queue passes over it, and the next wait or lock makes another.
   */
  private timed(f: () => void): void {
    try {
      f();
    } catch (e) {
      if (e instanceof SyncTimeout && this.record !== 0) {
        Atomics.store(this.words, this.record + OWNER, -1);
        this.record = 0;
      }

      throw e;
    }
  }

  /** This thread's record, made once, and again after a timeout gave it up. */
  private ownRecord(): number {
    if (this.record === 0) {
      this.record = this.alloc(4);
      Atomics.store(this.words, this.record + OWNER, this.thread);
    }

    return this.record;
  }

  /** Take record `r`, whose wait timed out, from the queue of `c`, if a notify has not passed over it. */
  private unqueue(c: number, r: number): void {
    const words = this.words;
    let previous = 0;
    let at = Atomics.load(words, c + HEAD);
    while (at !== 0 && at !== r) {
      previous = at;
      at = Atomics.load(words, at + C_NEXT);
    }

    if (at === 0) {
      return;
    }

    const next = Atomics.load(words, r + C_NEXT);
    if (previous === 0) {
      Atomics.store(words, c + HEAD, next);
    } else {
      Atomics.store(words, previous + C_NEXT, next);
    }

    if (Atomics.load(words, c + TAIL) === r) {
      Atomics.store(words, c + TAIL, previous);
    }
  }

  newQueue(): number {
    return this.alloc(5);
  }

  /** How many entries queue `q` holds. */
  queued(q: number): number {
    return Atomics.load(this.words, q + Q_COUNT);
  }

  closed(q: number): boolean {
    return Atomics.load(this.words, q + Q_CLOSED) !== 0;
  }

  /** Add `bytes` at the end of queue `q`, waking a thread that waits on it. */
  push(q: number, bytes: Uint8Array): void {
    const words = this.words;
    const entry = this.alloc(2 + Math.ceil(bytes.length / 4));
    words[entry + 1] = bytes.length;
    this.bytes.set(bytes, (entry + 2) * 4);
    this.acquire(q + Q_LOCK, Date.now());
    try {
      const tail = Atomics.load(words, q + Q_TAIL);
      if (tail === 0) {
        Atomics.store(words, q + Q_HEAD, entry);
      } else {
        Atomics.store(words, tail, entry);
      }

      Atomics.store(words, q + Q_TAIL, entry);
      Atomics.add(words, q + Q_COUNT, 1);
    } finally {
      this.release(q + Q_LOCK);
    }

    Atomics.notify(words, q + Q_COUNT);
  }

  /** Take the first entry of queue `q`, if it has one. */
  shift(q: number): Uint8Array | null {
    const words = this.words;
    let entry: number;
    this.acquire(q + Q_LOCK, Date.now());
    try {
      entry = Atomics.load(words, q + Q_HEAD);
      if (entry === 0) {
        return null;
      }

      const next = Atomics.load(words, entry);
      Atomics.store(words, q + Q_HEAD, next);
      if (next === 0) {
        Atomics.store(words, q + Q_TAIL, 0);
      }

      Atomics.sub(words, q + Q_COUNT, 1);
    } finally {
      this.release(q + Q_LOCK);
    }

    const at = (entry + 2) * 4;
    const bytes = this.bytes.slice(at, at + words[entry + 1]);
    this.free(entry);
    return bytes;
  }

  /** Mark queue `q` closed, waking a thread that waits on it. */
  close(q: number): void {
    Atomics.store(this.words, q + Q_CLOSED, 1);
    Atomics.notify(this.words, q + Q_COUNT);
  }

  /** Block until queue `q` holds an entry or is closed. */
  waitFor(q: number): void {
    const start = Date.now();
    while (!this.closed(q)) {
      const count = Atomics.load(this.words, q + Q_COUNT);
      if (count > 0) {
        return;
      }

      this.park(q + Q_COUNT, count, CHUNK, start);
    }
  }
}
