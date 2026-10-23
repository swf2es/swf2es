// avmshell's workers, as avmplus' Aggregate and Isolate keep them: each
// worker's state, parent and shared properties in memory every thread
// sees, so that a worker's state and what another worker set are seen at
// once, while the primordial spins in System.sleep. The memory is a
// SharedArrayBuffer where there is one, as node always has; elsewhere an
// ArrayBuffer, and there are no other threads to start.
//
// The host starts the threads (RuntimeOptions.workers); each runs a
// runtime made with its worker's ShellWorkerInit, which the runtime finds
// here by its id.

import type { Value } from "../descriptors.js";
import type { ShellWorkerInit, ShellWorkersMemory } from "../options.js";
import { fromUtf8, utf8 } from "./bytearray.js";
import { Sync, type SyncMemory } from "./sync.js";

/** avmplus' Isolate::State. */
export const NEW = 1;
export const CANSTART = 2;
export const STARTING = 3;
export const RUNNING = 4;
export const FINISHING = 5;
export const TERMINATED = 6;
export const FAILED = 7;
export const ABORTED = 8;
export const EXCEPTION = 9;

/** Worker.state's names for each, as WorkerObjectBase::get_state reports them. */
export const STATE_NAMES = [
  "",
  "new",
  "new",
  "new",
  "running",
  "running",
  "terminated",
  "failed",
  "aborted",
  "exception",
];

// The control memory's words: the table's lock, the workers made, the
// table's version and the next item token; then each worker's state and
// parent, two words a worker.
const LOCK = 0;
const COUNT = 1;
const VERSION = 2;
const TOKEN = 3;
const WORKERS = 4;
const CONTROL_MAX = 16 << 20;
const TABLE_MAX = 256 << 20;

/**
 * How a shared property is kept: AMF3, a ByteArray's bytes, a Mutex or a
 * Condition by its address in the sync memory (a byte, 0 for a Mutex, then
 * an int32), a Number's float64, or a shareable ByteArray's memory by its
 * id, as a float64.
 */
export const ITEM_AMF = 0;
export const ITEM_BYTES = 1;
export const ITEM_SYNC = 2;
export const ITEM_NUMBER = 3;
export const ITEM_SHARED = 4;

export interface SharedEntry {
  id: number;
  key: string | null;
  kind: number;
  /** The worker whose VM set it. */
  writer: number;
  /** Unique to this set, by which a VM keeps the one object it gives for it. */
  token: number;
  bytes: Uint8Array;
}

interface GrowableBuffer {
  readonly byteLength: number;
  grow?(length: number): void;
  resize?(length: number): void;
}

type GrowableConstructor = new (
  length: number,
  options: { maxByteLength: number },
) => ArrayBuffer | SharedArrayBuffer;

/** Growable memory, shared where SharedArrayBuffer is. */
function growable(length: number, max: number): ArrayBuffer | SharedArrayBuffer {
  const shared = typeof SharedArrayBuffer === "function";
  const ctor = (shared ? SharedArrayBuffer : ArrayBuffer) as unknown as GrowableConstructor;
  return new ctor(length, { maxByteLength: max });
}

function grow(buffer: ArrayBuffer | SharedArrayBuffer, length: number): void {
  const b = buffer as unknown as GrowableBuffer;
  if (b.byteLength >= length) {
    return;
  }

  if (b.grow) {
    b.grow(length);
  } else {
    b.resize?.(length);
  }
}

/** New memory for the workers of a primordial, itself worker 0, running, whose Mutexes live in `sync`. */
export function newWorkersMemory(sync: SyncMemory): ShellWorkersMemory {
  const memory = {
    control: growable((WORKERS + 2) * 4, CONTROL_MAX),
    table: growable(4, TABLE_MAX),
    sync,
  };
  const control = new Int32Array(memory.control);
  control[COUNT] = 1;
  control[WORKERS] = RUNNING;
  control[WORKERS + 1] = -1;
  return memory;
}

/** Wait up to `ms` on `word` while it holds `value`, spinning where this thread cannot block. */
function waitOn(words: Int32Array, index: number, value: number, ms: number): void {
  try {
    Atomics.wait(words, index, value, ms);
  } catch {
    // An ArrayBuffer's, or a browser's main thread, which cannot block.
  }
}

/** Thrown in a worker that was terminated, as avmplus interrupts it: its code stops. */
export class WorkerTerminated extends Error {
  constructor() {
    super("swf2es: the worker was terminated");
  }
}

/** The workers as one VM sees them, over the memory they share. */
export class Workers {
  readonly control: Int32Array;
  /** The Mutexes' and Conditions' memory, told which workers have ended. */
  private readonly sync: Sync;
  /** The table as last read, and its version. */
  private entries = new Map<string, SharedEntry>();
  private version = 0;
  /**
   * This VM's object for each property whose identity it keeps, a
   * ByteArray, by entryKey, with its item's token.
   */
  readonly objects = new Map<string, { token: number; value: Value }>();

  constructor(
    readonly memory: ShellWorkersMemory,
    /** The worker this VM runs. */
    readonly self: number,
  ) {
    this.control = new Int32Array(memory.control);
    this.sync = new Sync(memory.sync, self);
  }

  /** A worker's state; one past those made has none. */
  state(id: number): number {
    return this.words(id) ? Atomics.load(this.control, WORKERS + 2 * id) : 0;
  }

  parent(id: number): number {
    return this.words(id) ? Atomics.load(this.control, WORKERS + 2 * id + 1) : -1;
  }

  /** Move worker `id` from `from` to `to`; whether it was in `from`. */
  transition(id: number, from: number, to: number): boolean {
    return Atomics.compareExchange(this.control, WORKERS + 2 * id, from, to) === from;
  }

  setState(id: number, to: number): void {
    Atomics.store(this.control, WORKERS + 2 * id, to);
  }

  /** A new worker of this one's, NEW. */
  create(): number {
    return this.locked(() => {
      const id = this.control[COUNT];
      // The views track the memory's length as it grows.
      grow(this.memory.control, (WORKERS + 2 * (id + 1)) * 4);
      this.control[WORKERS + 2 * id] = NEW;
      this.control[WORKERS + 2 * id + 1] = this.self;
      this.sync.addThread(id);
      Atomics.store(this.control, COUNT, id + 1);
      return id;
    });
  }

  /** The workers made so far, by id. */
  count(): number {
    return Atomics.load(this.control, COUNT);
  }

  get(id: number, key: string | null): SharedEntry | undefined {
    if (Atomics.load(this.control, VERSION) !== this.version) {
      this.locked(() => this.read());
    }

    return this.entries.get(entryKey(id, key));
  }

  /** Set worker `id`'s property `key`, or delete it with a null `item`; the item's token. */
  set(id: number, key: string | null, item: { kind: number; bytes: Uint8Array } | null): number {
    return this.locked(() => {
      this.read();
      let token = 0;
      if (item) {
        token = Atomics.add(this.control, TOKEN, 1) + 1;
        const entry = { id, key, kind: item.kind, writer: this.self, token, bytes: item.bytes };
        this.entries.set(entryKey(id, key), entry);
      } else {
        this.entries.delete(entryKey(id, key));
      }

      this.write();
      return token;
    });
  }

  /**
   * Terminate worker `id`, started and not yet ended, and the workers it
   * started, theirs and so on, whose threads stop with its own: each
   * `terminated`, its properties let go, as Isolate::releaseActiveResources.
   * Whether `id` was running. Done holding the lock, so that none of them
   * is in the table then, and none takes the lock again (see locked): its
   * thread may be stopped anywhere once this returns.
   */
  terminate(id: number): boolean {
    return this.locked(() => {
      const state = this.state(id);
      if (state <= NEW || state > RUNNING) {
        return false;
      }

      const ended = new Set([id]);
      // A worker's number is above its parent's.
      for (let d = id + 1; d < this.count(); d++) {
        const s = this.state(d);
        if (ended.has(this.parent(d)) && s > NEW && s <= RUNNING) {
          ended.add(d);
        }
      }

      // Their properties first: once a worker holding the lock is
      // terminated, another may take the lock from it (see locked).
      this.drop(ended);
      for (const d of ended) {
        this.setState(d, TERMINATED);
        this.sync.end(d);
      }

      return true;
    });
  }

  /** This VM's worker has ended, as `to`, its properties let go; unless it was terminated already. */
  end(to: number): void {
    this.locked(() => {
      // Its state last, as in terminate.
      if (this.state(this.self) === RUNNING) {
        this.drop(new Set([this.self]));
        this.sync.end(this.self);
        this.setState(this.self, to);
      }
    });
  }

  /** Remove the properties of the workers `ids`, holding the lock. */
  private drop(ids: Set<number>): void {
    this.read();
    let changed = false;
    for (const [k, e] of this.entries) {
      if (ids.has(e.id)) {
        this.entries.delete(k);
        changed = true;
      }
    }

    if (changed) {
      this.write();
    }
  }

  private words(id: number): boolean {
    return id >= 0 && id < Atomics.load(this.control, COUNT);
  }

  /**
   * Run `f` holding the table's lock, whose word holds its holder's id
   * plus one. A worker's thread is stopped only after it was terminated
   * under the lock (terminate), and a terminated worker changes nothing
   * holding it: it throws WorkerTerminated instead. It may still take the
   * lock to find that out, as it can have been waiting for it while it
   * was terminated, and be stopped there; so a lock held by a worker that
   * was terminated is taken from it.
   */
  private locked<T>(f: () => T): T {
    const me = this.self + 1;
    for (;;) {
      const holder = Atomics.compareExchange(this.control, LOCK, 0, me);
      if (holder === 0) {
        break;
      }

      if (
        holder !== 1 &&
        this.state(holder - 1) > RUNNING &&
        Atomics.compareExchange(this.control, LOCK, holder, me) === holder
      ) {
        break;
      }

      waitOn(this.control, LOCK, holder, 1);
    }

    try {
      if (this.self !== 0 && this.state(this.self) > RUNNING) {
        throw new WorkerTerminated();
      }

      return f();
    } finally {
      Atomics.compareExchange(this.control, LOCK, me, 0);
      Atomics.notify(this.control, LOCK);
    }
  }

  /** The table from memory: its length, then each entry. */
  private read(): void {
    this.version = Atomics.load(this.control, VERSION);
    const table = new Uint8Array(this.memory.table);
    const view = new DataView(this.memory.table);
    const end = 4 + view.getUint32(0, true);
    this.entries.clear();

    let at = 4;
    while (at < end) {
      const id = view.getUint32(at, true);
      const keyLength = view.getInt32(at + 4, true);
      at += 8;
      const key = keyLength < 0 ? null : fromUtf8(table.slice(at, at + keyLength));
      at += Math.max(keyLength, 0);
      const kind = table[at];
      const writer = view.getUint32(at + 1, true);
      const token = view.getUint32(at + 5, true);
      const length = view.getUint32(at + 9, true);
      at += 13;
      const bytes = table.slice(at, at + length);
      at += length;
      this.entries.set(entryKey(id, key), { id, key, kind, writer, token, bytes });
    }
  }

  /**
   * The table into memory, its length first, in one copy: a thread
   * stopped mid-way leaves the old table or the new one.
   */
  private write(): void {
    const parts: Uint8Array[] = [];
    let length = 0;
    for (const e of this.entries.values()) {
      const key = e.key === null ? null : utf8(e.key);
      const head = new Uint8Array(8);
      const headView = new DataView(head.buffer);
      headView.setUint32(0, e.id, true);
      headView.setInt32(4, key === null ? -1 : key.length, true);
      const item = new Uint8Array(13);
      const itemView = new DataView(item.buffer);
      item[0] = e.kind;
      itemView.setUint32(1, e.writer, true);
      itemView.setUint32(5, e.token, true);
      itemView.setUint32(9, e.bytes.length, true);
      parts.push(head);
      if (key) {
        parts.push(key);
      }

      parts.push(item, e.bytes);
      length += head.length + (key?.length ?? 0) + item.length + e.bytes.length;
    }

    const out = new Uint8Array(4 + length);
    new DataView(out.buffer).setUint32(0, length, true);
    let at = 4;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }

    grow(this.memory.table, out.length);
    new Uint8Array(this.memory.table).set(out);
    this.version = Atomics.add(this.control, VERSION, 1) + 1;
  }
}

/** A property's key among all the workers'. */
export const entryKey = (id: number, key: string | null) => `${id}${key === null ? "" : `:${key}`}`;

/**
 * A background worker's thread has begun, as avmplus' core once set up:
 * whether it is to run, which it is not once terminated.
 */
export function startShellWorker(init: ShellWorkerInit): boolean {
  return new Workers(init.memory, init.id).transition(init.id, CANSTART, RUNNING);
}

/**
 * A background worker's code has ended, normally or by an exception
 * nothing caught; its properties are let go, as when avmplus deletes its
 * core. One terminated meanwhile stays so.
 */
export function endShellWorker(init: ShellWorkerInit, exception: boolean): void {
  try {
    new Workers(init.memory, init.id).end(exception ? EXCEPTION : TERMINATED);
  } catch (e) {
    if (!(e instanceof WorkerTerminated)) {
      throw e;
    }
  }
}

/** Whether a background worker was terminated: its thread's end is then no failure. */
export function shellWorkerTerminated(init: ShellWorkerInit): boolean {
  return new Workers(init.memory, init.id).state(init.id) > RUNNING;
}

/** Sleep `ms` milliseconds, as System.sleep: blocking where the thread can, else spinning. */
export function sleep(ms: number): void {
  if (ms <= 0) {
    return;
  }

  const end = Date.now() + ms;
  if (typeof SharedArrayBuffer === "function") {
    const word = new Int32Array(new SharedArrayBuffer(4));
    try {
      Atomics.wait(word, 0, 0, ms);
      return;
    } catch {
      // A browser's main thread, which cannot block.
    }
  }

  while (Date.now() < end) {
    // Spin.
  }
}
