// flash.system's workers as one VM sees them (docs/workers.md): the
// primordial starts each background worker on a thread of its host's and
// routes what crosses between them; a background worker's VM reaches only
// the primordial. Shared properties and channels' messages cross as copies,
// made as avmplus' ChannelItem makes them, so a host's channel carries
// plain data, but for a shareable ByteArray's memory, which every worker
// shares, and a Mutex or a Condition, an address in the memory every
// worker is given (avm2.Sync). Where memory is shared, the shared
// properties are a table in it and a channel's queue is in it, so that
// every worker sees them at once and a receiver can block on a queue, and
// a background worker starts a worker through a queue the primordial takes
// even while it waits. Elsewhere each side keeps its own copy of a worker's
// shared properties and of a channel's queue, and what one side sets or
// sends reaches the other between its frames.
import { avm2 } from "@swf2es/runtime";
import type { WorkerHost, WorkerThread } from "../hosts.js";
import type { Scripting } from "../scripting.js";
import type {
  ChannelClose,
  ChannelMessage,
  ChannelRef,
  FromWorker,
  SharedMessage,
  ToWorker,
  WireValue,
} from "../workers/protocol.js";
import {
  type PackedValue,
  pack,
  packEnd,
  packJob,
  packTable,
  type TableEntry,
  unpack,
  unpackRequest,
  unpackTable,
} from "../workers/wire.js";
import { dispatchEvent } from "./events.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The primordial worker's id; background workers count up from 1. */
export const PRIMORDIAL = 0;

/** How a background worker's VM reaches the primordial, which started it. */
export interface ParentLink {
  /** The worker's own id. */
  id: number;
  post(message: FromWorker): void;
  /** Its shared properties and the primordial's, as the primordial had them when it started. */
  shared: SharedMessage[];
}

/** How long a terminated worker's thread is given to stop itself before its host stops it. */
const STOP_WAIT = 1000;

/**
 * Stop the thread of worker `id`, terminated. A thread may be stopped
 * anywhere, even where it writes what a Mutex it holds guards, so its
 * Mutexes are let go only once it has stopped. The thread stops itself
 * between frames once it sees it was terminated, which one that waits or
 * is idle does at once and one that plays at the end of its frame, and
 * says so (thread.ts); one that has not within STOP_WAIT is stopped by its
 * host, and its Mutexes let go once the host says it has gone.
 */
function stopThread(sync: avm2.Sync, id: number, thread: WorkerThread): void {
  const start = Date.now();
  const look = () => {
    if (sync.stopped(id)) {
      void thread.terminate();
    } else if (Date.now() - start >= STOP_WAIT) {
      void Promise.resolve(thread.terminate()).then(() => sync.end(id));
    } else {
      setTimeout(look, 10);
    }
  };
  setTimeout(look, 10);
}

/**
 * A background worker the primordial runs; in a background worker's VM,
 * one it made, whose thread the primordial runs for it.
 */
interface Background {
  id: number;
  /** The background worker that made it, or null for the primordial. */
  creator: number | null;
  /** Empty once it has started: the thread was given its copy. */
  swf: Uint8Array<ArrayBuffer>;
  /** "starting" from start() until the thread runs, which scripts see as "new". */
  state: "new" | "starting" | "running" | "terminated";
  thread: WorkerThread | null;
  /** What was posted before the thread was there, posted once it is. */
  pending: ToWorker[];
  /** Messages posted to the thread, init the first, and the waits for it to have run them. */
  sent: number;
  waits: { upTo: number; done: () => void }[];
}

/** A MessageChannel as this VM knows it: its queue is the receiver's, or in shared memory. */
interface Channel {
  ref: ChannelRef;
  state: "open" | "closing" | "closed";
  queue: WireValue[];
  /**
   * Sent from the primordial to a background worker that has not yet run
   * a frame since: what messageAvailable sees on the sending side where
   * the queue is not in shared memory.
   */
  undelivered: number;
  /** Its AS3 object in this VM, made when a script first has it. */
  object: AsObject | null;
}

/** A shared property: what crosses, and the value itself where it reads back as itself. */
interface Shared {
  wire: WireValue;
  local: Value;
  /** Its entry's in the shared table, where this VM set it. */
  token?: number;
}

/** A shared property's key in the shared table. */
const tableKey = (worker: number, key: string | null) =>
  `${worker}${key === null ? "" : `:${key}`}`;

const STATES = { new: "new", starting: "new", running: "running", terminated: "terminated" };

export class Workers {
  /** This VM's worker: the primordial's 0, or a background worker's own. */
  readonly id: number;
  private readonly host: WorkerHost | null;
  private readonly parent: ParentLink | null;
  /** The background workers made and not terminated; what they held goes with them. */
  private readonly backgrounds = new Map<number, Background>();
  /** Those terminated, by id alone. */
  private readonly ended = new Set<number>();
  /** The Worker objects of this VM, one a worker. */
  private readonly objects = new Map<number, AsObject>();
  private readonly shared = new Map<number, Map<string | null, Shared>>();
  private readonly channels = new Map<number, Channel>();
  /** Each shareable ByteArray's memory this VM has seen, by its id, for a message in a shared queue that names it. */
  private readonly memories = new Map<number, avm2.SharedBytesMemory>();
  private nextChannel = 1;
  /** The shared table as last read, by tableKey, and its version. */
  private table: { version: number; entries: Map<string, TableEntry> } | null = null;
  /** Whether the primordial is starting the workers background workers asked for. */
  private servicing = false;
  /** The libraries the SWFs link against, as loaded, which a worker's thread loads too. */
  libraries: Uint8Array[] = [];

  constructor(
    private readonly s: Scripting,
    options: { workerHost?: WorkerHost | null; workerParent?: ParentLink | null },
  ) {
    this.parent = options.workerParent ?? null;
    this.host = this.parent ? null : (options.workerHost ?? null);
    this.id = this.parent?.id ?? PRIMORDIAL;
    if (this.parent) {
      for (const message of this.parent.shared) {
        this.applyShared(message);
      }
    }
  }

  /** Worker.isSupported: whether another worker can run beside this one. */
  get supported(): boolean {
    return this.parent !== null || this.host !== null;
  }

  /** The Worker object of worker `id` in this VM; `cls` is Worker's class, while it is being made. */
  objectOf(id: number, cls?: AsObject): AsObject {
    let o = this.objects.get(id);
    if (!o) {
      const rt = this.s.rt;
      o = rt.constructClass(cls ?? rt.classNamed("flash.system::Worker"), []) as AsObject;
      o.$worker = id;
      this.objects.set(id, o);
    }

    return o;
  }

  /** WorkerDomain.createWorker: a worker in state "new" that will run `swf`, copied now. */
  create(swf: Value): AsObject {
    const rt = this.s.rt;
    if (swf === null || swf === undefined) {
      throw rt.error("TypeError", 2007, "swf");
    }

    if (!this.parent && !this.host) {
      throw rt.unsupported("creating a Worker without a worker host");
    }

    // Numbered in the memory every worker shares, so that one a background
    // worker makes has a number of its own.
    const sync = avm2.syncOf(rt);
    if (this.parent && !sync.shared) {
      throw avm2.notIsolated("a Worker a background worker makes");
    }

    const bytes = avm2.bytesOf(rt, swf as AsObject);
    const id = sync.newThread();
    this.backgrounds.set(id, {
      id,
      creator: this.parent ? this.id : null,
      swf: bytes.buffer.slice(0, bytes.length),
      state: "new",
      thread: null,
      pending: [],
      sent: 0,
      waits: [],
    });
    return this.objectOf(id);
  }

  start(id: number): void {
    const rt = this.s.rt;
    const background = this.backgrounds.get(id);
    if (!background) {
      throw rt.error(
        "flash.errors::IllegalOperationError",
        id === this.id || id === PRIMORDIAL || this.ended.has(id) ? 1511 : 1521,
      );
    }

    if (background.state !== "new") {
      throw rt.error("flash.errors::IllegalOperationError", 1511);
    }

    if (this.parent) {
      // The primordial starts it on its host, and tells this VM its state.
      // The request goes in its queue in shared memory, which it takes
      // even while it waits, as Crossbridge's primordial may wait for
      // what this worker is starting the new one for.
      const sync = avm2.syncOf(rt);
      if (sync.requests === 0) {
        throw rt.unsupported(
          "starting a Worker from a background worker the primordial did not start",
        );
      }

      background.state = "starting";
      const shared = [...this.propertiesOf(id)].map(([key, p]) => ({
        worker: id,
        key,
        value: p.wire,
      }));
      this.request(packJob(id, this.id, background.swf, shared));
      background.swf = new Uint8Array(0);
      return;
    }

    this.takeRequests();
    const host = this.host as WorkerHost;
    background.state = "starting";
    const shared = [id, PRIMORDIAL].flatMap((worker) =>
      [...this.propertiesOf(worker)].map(
        ([key, p]): SharedMessage => ({ type: "shared", worker, key, value: p.wire }),
      ),
    );
    const swf = background.swf;
    background.swf = new Uint8Array(0);
    background.sent = 1;
    this.wait(background, 1);
    try {
      background.thread = host.start(
        {
          type: "init",
          id,
          swf,
          url: this.s.url,
          sandboxType: this.s.sandboxType,
          libraries: this.libraries,
          shared,
          sync: avm2.syncOf(rt).memory,
          modules: this.s.code.handedModules(),
        },
        (message) => this.fromBackground(background, message),
        (error) => {
          if (background.state !== "terminated") {
            this.s.reportUncaught(error);
            this.end(background);
          }
        },
      );
    } catch {
      // The host could start no thread, as a page's policy may forbid the
      // worker's script. Flash's nearest is a player that has workers
      // disabled, which start reports with 3807; the worker is terminated.
      this.end(background);
      throw rt.error("flash.errors::IllegalOperationError", 3807);
    }

    for (const message of background.pending.splice(0)) {
      this.post(background, message);
    }
  }

  /** Worker.terminate: true where it was started and still runs. */
  terminate(id: number): boolean {
    if (id === PRIMORDIAL) {
      throw this.s.rt.error("flash.errors::IllegalOperationError", 3732);
    }

    // A worker may end itself; the primordial stops its thread. Until it
    // has, the shared memory refuses it anything more.
    if (this.parent && id === this.id) {
      avm2.syncOf(this.s.rt).stop(id);
      this.parent.post({ type: "terminate" });
      return true;
    }

    const background = this.backgrounds.get(id);
    if (!background || background.state === "new" || background.state === "terminated") {
      return false;
    }

    // One this background worker made: the primordial stops its thread,
    // asked through its queue, which it takes even while it waits.
    if (this.parent) {
      this.request(packEnd(id, this.id));
    }

    this.end(background);
    return true;
  }

  /** Put `bytes` in the primordial's queue of requests, and tell it. */
  private request(bytes: Uint8Array): void {
    const sync = avm2.syncOf(this.s.rt);
    this.inShared(() => sync.push(sync.requests, bytes));
    this.parent?.post({ type: "requests" });
  }

  /** What `f` does in the shared memory, its errors a script's: MemoryError 1000 where it is full. */
  private inShared<T>(f: () => T): T {
    try {
      return f();
    } catch (e) {
      throw avm2.syncError(this.s.rt, e);
    }
  }

  state(id: number): string {
    if (id === this.id || id === PRIMORDIAL) {
      return "running";
    }

    // One this background worker made runs as soon as its own thread says so.
    const background = this.backgrounds.get(id);
    if (background?.state === "starting" && avm2.syncOf(this.s.rt).running(id)) {
      return "running";
    }

    return STATES[background?.state ?? "terminated"];
  }

  /** WorkerDomain.listWorkers: the running workers, the primordial first, as Flash lists them. */
  list(): AsObject[] {
    if (this.parent) {
      return [this.objectOf(PRIMORDIAL), this.objectOf(this.id)];
    }

    const running = [...this.backgrounds.values()].filter((b) => b.state === "running");
    return [this.objectOf(PRIMORDIAL), ...running.map((b) => this.objectOf(b.id))];
  }

  setShared(id: number, key: string | null, value: Value): void {
    if (this.ended.has(id)) {
      return;
    }

    const own = this.propertiesOf(id);
    if (value === undefined) {
      own.delete(key);
    } else {
      const wire = this.encode(value);
      // A ByteArray read back by the worker that set it is itself, as in Flash.
      own.set(key, { wire, local: wire.kind === "bytes" ? value : undefined });
    }

    // Where memory is shared, in the table every worker reads at once.
    const sync = avm2.syncOf(this.s.rt);
    if (sync.shared) {
      const p = own.get(key);
      if (p) {
        p.token = sync.nextToken();
      }

      this.inShared(() =>
        sync.updateTable((bytes) => {
          const entries = unpackTable(bytes).filter((e) => e.worker !== id || e.key !== key);
          if (p?.token !== undefined) {
            entries.push({ worker: id, key, token: p.token, value: pack(p.wire) });
          }

          return packTable(entries);
        }),
      );
    }

    const message: SharedMessage = {
      type: "shared",
      worker: id,
      key,
      value: value === undefined ? null : (own.get(key) as Shared).wire,
    };
    if (this.parent) {
      this.parent.post(message);
    } else {
      this.share(message, PRIMORDIAL);
    }
  }

  /** A shared property set, posted on by the primordial: the primordial's to every worker but `from`. */
  private share(message: SharedMessage, from: number): void {
    for (const background of this.backgrounds.values()) {
      const to = background.id;
      const ofCreator = this.backgrounds.get(message.worker)?.creator === to;
      if (to !== from && (message.worker === PRIMORDIAL || message.worker === to || ofCreator)) {
        // One not started gets it with the rest when it starts.
        if (background.state !== "new") {
          this.post(background, message);
        }
      }
    }
  }

  getShared(id: number, key: string | null): Value {
    const p = this.shared.get(id)?.get(key);
    if (avm2.syncOf(this.s.rt).shared) {
      // What any worker set last, at once; this VM's own value where it set it.
      const entry = this.tableEntries().get(tableKey(id, key));
      if (!entry) {
        return undefined;
      }

      if (p?.token !== entry.token) {
        return this.decode(this.unpacked(unpack(entry.value)));
      }
    }

    if (!p) {
      return undefined;
    }

    return p.local !== undefined ? p.local : this.decode(p.wire);
  }

  /** The shared table's entries, read again where another worker has changed it. */
  private tableEntries(): Map<string, TableEntry> {
    const sync = avm2.syncOf(this.s.rt);
    if (this.table?.version !== sync.tableVersion()) {
      const { version, bytes } = sync.readTable();
      const entries = new Map<string, TableEntry>();
      for (const e of unpackTable(bytes)) {
        entries.set(tableKey(e.worker, e.key), e);
      }

      this.table = { version, entries };
    }

    return this.table.entries;
  }

  /** Worker.createMessageChannel: a channel from `sender` to `receiver`. */
  createChannel(sender: number, receiver: number): AsObject {
    // Ids made by a background worker are its own, apart from the primordial's.
    const id = this.id * 0x100000 + this.nextChannel++;
    const sync = avm2.syncOf(this.s.rt);
    const queue = sync.shared ? this.inShared(() => sync.newQueue()) : 0;
    return this.channelObject({ id, sender, receiver, queue });
  }

  send(o: AsObject, value: Value): void {
    const rt = this.s.rt;
    const channel = this.channelOf(o);
    if (channel.ref.sender !== this.id) {
      throw rt.error("ArgumentError", 3736);
    }

    if (channel.state !== "open") {
      throw rt.error("flash.errors::IOError", 3738);
    }

    const wire = this.encode(value);
    if (channel.ref.queue !== 0) {
      // Queued at once where both ends see it; the notice brings the
      // receiver its channelMessage, and a shareable ByteArray's memory.
      const sync = avm2.syncOf(this.s.rt);
      this.inShared(() => sync.push(channel.ref.queue, pack(wire)));
      const notice = wire.kind === "shared" ? wire : null;
      this.route({ type: "message", channel: channel.ref, value: notice }, this.id);
      return;
    }

    this.route({ type: "message", channel: channel.ref, value: wire }, this.id);
  }

  receive(o: AsObject, block: boolean): Value {
    const rt = this.s.rt;
    const channel = this.channelOf(o);
    if (channel.ref.receiver !== this.id) {
      throw rt.error("ArgumentError", 3737);
    }

    if (channel.ref.queue !== 0) {
      return this.receiveShared(channel, block);
    }

    const wire = channel.queue.shift();
    if (wire === undefined) {
      if (channel.state === "closed") {
        throw rt.error("flash.errors::IOError", 3738);
      }

      if (block) {
        throw rt.unsupported("MessageChannel.receive(true) with no message queued");
      }

      return undefined;
    }

    // The last of a closing channel's closes it, with no event here: Flash
    // dispatches one at a close, which tells the state as the event comes.
    if (channel.state === "closing" && channel.queue.length === 0) {
      channel.state = "closed";
      this.drained(channel);
    }

    return this.decode(wire);
  }

  /**
   * The first message of a channel whose queue is in shared memory,
   * waiting for one with `block`: in a worker with Atomics.wait, on the
   * primordial of a page spinning, up to Flash's script timeout.
   */
  private receiveShared(channel: Channel, block: boolean): Value {
    const rt = this.s.rt;
    const sync = avm2.syncOf(rt);
    const q = channel.ref.queue;
    let bytes = sync.shift(q);
    if (bytes === null && block && channel.state === "open") {
      try {
        sync.waitFor(q);
      } catch (e) {
        throw avm2.syncError(rt, e);
      }

      bytes = sync.shift(q);
    }

    if (bytes === null) {
      if (channel.state === "closed" || (block && sync.closed(q))) {
        throw rt.error("flash.errors::IOError", 3738);
      }

      return undefined;
    }

    if (channel.state === "closing" && sync.queued(q) === 0) {
      channel.state = "closed";
      this.drained(channel);
    }

    return this.decode(this.unpacked(unpack(bytes)));
  }

  /** A value from a shared queue, a shareable ByteArray's memory found by its id. */
  private unpacked(value: PackedValue): WireValue {
    if (value.kind !== "shared") {
      return value;
    }

    const memory = this.memories.get(value.id);
    if (!memory) {
      // Its memory comes in a message, which a worker that has not been
      // back in its event loop since another shared it has not taken.
      throw this.s.rt.unsupported(
        "reading a shareable ByteArray another worker shared before its memory reached this one",
      );
    }

    return { kind: "shared", memory };
  }

  messageAvailable(o: AsObject): boolean {
    const channel = this.channelOf(o);
    if (channel.ref.queue !== 0) {
      return avm2.syncOf(this.s.rt).queued(channel.ref.queue) > 0;
    }

    return channel.ref.receiver === this.id ? channel.queue.length > 0 : channel.undelivered > 0;
  }

  channelState(o: AsObject): string {
    return this.channelOf(o).state;
  }

  /** MessageChannel.close: closing while the receiver has messages queued, then closed. */
  close(o: AsObject): void {
    const channel = this.channelOf(o);
    if (channel.state !== "open") {
      return;
    }

    if (channel.ref.queue !== 0) {
      // Wakes a receiver blocked on it.
      avm2.syncOf(this.s.rt).close(channel.ref.queue);
    }

    this.route({ type: "close", channel: channel.ref, drained: false }, this.id);
    this.closed(channel);
  }

  /** Stop every background worker's thread, as the player goes. */
  stopAll(): void {
    // A terminated background worker leaves the workers it made to the
    // primordial, which runs them; the shared memory refuses it anything.
    if (this.parent && avm2.syncOf(this.s.rt).terminated) {
      return;
    }

    for (const background of this.backgrounds.values()) {
      if (background.state !== "new" && background.state !== "terminated") {
        this.end(background);
      }
    }

    this.host?.release?.();
  }

  /** A message from the primordial, in a background worker's VM. */
  fromParent(message: ToWorker): void {
    switch (message.type) {
      case "shared":
        this.applyShared(message);
        break;
      case "message":
      case "close":
        this.arrive(message);
        break;
      case "state": {
        const child = this.backgrounds.get(message.worker);
        if (child && message.state === "running" && child.state === "starting") {
          child.state = "running";
          this.stateChanged(child.id);
        } else if (child && message.state === "terminated") {
          this.end(child);
        }

        break;
      }
      case "init":
        break;
    }
  }

  private fromBackground(background: Background, message: FromWorker): void {
    if (background.state === "terminated") {
      return;
    }

    switch (message.type) {
      case "running":
        background.state = "running";
        this.stateChanged(background.id);
        this.toCreator(background, "running");
        break;
      case "requests":
        this.serviceRequests();
        break;
      case "idle":
        for (const w of background.waits.filter((w) => w.upTo <= message.received)) {
          w.done();
        }

        background.waits = background.waits.filter((w) => w.upTo > message.received);
        for (const channel of this.channels.values()) {
          if (channel.ref.receiver === background.id) {
            channel.undelivered = 0;
          }
        }

        break;
      case "trace":
        this.s.rt.print(message.line);
        break;
      case "uncaught":
        this.s.reportUncaught(new Error(`a background worker: ${message.text}`));
        break;
      case "terminate":
        this.end(background);
        break;
      case "shared":
        this.applyShared(message);
        this.share(message, background.id);
        break;
      case "message":
      case "close":
        this.route(message, background.id);
        break;
    }
  }

  /**
   * A message on its way to the channel's receiver, or a close to both its
   * ends but the one it came from. A background worker's go through the
   * primordial, which routes them on.
   */
  private route(message: ChannelMessage | ChannelClose, from: number): void {
    const ref = message.channel;
    // The primordial's own copy of a channel between two others follows its state.
    if (
      !this.parent &&
      message.type === "close" &&
      ref.sender !== this.id &&
      ref.receiver !== this.id
    ) {
      const channel = this.channels.get(ref.id);
      const state = message.drained ? "closed" : "closing";
      if (channel && channel.state !== state && channel.state !== "closed") {
        channel.state = state;
        this.stateEvent(channel);
      }
    }

    const ends = message.type === "close" ? [ref.sender, ref.receiver] : [ref.receiver];
    let parentPosted = false;
    for (const to of new Set(ends)) {
      if (to === from && message.type === "close") {
        continue;
      }

      if (to === this.id) {
        this.arrive(message);
      } else if (this.parent) {
        if (!parentPosted) {
          this.parent.post(message);
          parentPosted = true;
        }
      } else {
        const background = this.backgrounds.get(to);
        if (background) {
          if (message.type === "message" && ref.queue === 0) {
            this.channel(ref).undelivered++;
          }

          this.post(background, message);
        }
      }
    }
  }

  /** A message or a close at this end of a channel, its event dispatched in the next frame. */
  private arrive(message: ChannelMessage | ChannelClose): void {
    const channel = this.channel(message.channel);
    if (message.type === "close") {
      if (message.drained) {
        if (channel.state !== "closed") {
          channel.state = "closed";
          this.stateEvent(channel);
        }
      } else if (channel.state === "open") {
        this.closed(channel);
      }

      return;
    }

    if (message.value?.kind === "shared") {
      this.memories.set(message.value.memory.id, message.value.memory);
    }

    if (message.channel.queue === 0 && message.value) {
      channel.queue.push(message.value);
    }

    this.s.loads.deferHostEvent(() => this.dispatch(channel, "channelMessage"));
  }

  /**
   * This end closed, by itself or by the other: closing until the
   * receiver's queue is empty, which only the receiver sees, so a sender on
   * another worker is closing until the receiver tells it (drained).
   */
  private closed(channel: Channel): void {
    const receiving = channel.ref.receiver === this.id;
    channel.state = receiving && this.queued(channel) === 0 ? "closed" : "closing";
    this.stateEvent(channel);
    if (receiving) {
      this.drained(channel);
    }
  }

  /** At the receiver, a channel just closed: the sender on another worker is told. */
  private drained(channel: Channel): void {
    if (channel.state === "closed" && channel.ref.sender !== this.id) {
      this.route({ type: "close", channel: channel.ref, drained: true }, this.id);
    }
  }

  /** How many messages wait at the receiver. */
  private queued(channel: Channel): number {
    return channel.ref.queue !== 0
      ? avm2.syncOf(this.s.rt).queued(channel.ref.queue)
      : channel.queue.length;
  }

  private stateEvent(channel: Channel): void {
    this.s.loads.deferHostEvent(() => this.dispatch(channel, "channelState"));
  }

  private dispatch(channel: Channel, type: string): void {
    if (channel.object) {
      dispatchEvent(this.s, channel.object, this.s.event(type));
    }
  }

  /** workerState for worker `id` in the next frame; `last`, its object is let go after it. */
  private stateChanged(id: number, last = false): void {
    this.s.loads.deferHostEvent(() => {
      const o = this.objects.get(id);
      if (o) {
        dispatchEvent(this.s, o, this.s.event("workerState"));
      }

      // A script that still holds a terminated worker's object reads its state by its id.
      if (last) {
        this.objects.delete(id);
      }
    });
  }

  /**
   * Make the queue of requests background workers start their workers
   * through, once the primordial starts one, where memory is shared; it
   * takes them whenever it waits as well as when it is told of one.
   */
  private takeRequests(): void {
    const sync = avm2.syncOf(this.s.rt);
    if (!sync.shared || sync.requests !== 0) {
      return;
    }

    sync.requests = sync.newQueue();
    sync.poll = () => {
      if (sync.queued(sync.requests) > 0) {
        this.serviceRequests();
      }
    };
  }

  /** Start each worker a background worker has asked for. */
  private serviceRequests(): void {
    const sync = avm2.syncOf(this.s.rt);
    // Starting one may wait for the shared heap, which polls again.
    if (this.servicing || sync.requests === 0) {
      return;
    }

    this.servicing = true;
    try {
      for (let bytes = sync.shift(sync.requests); bytes; bytes = sync.shift(sync.requests)) {
        const request = unpackRequest(bytes);
        if (request.type === "end") {
          const child = this.backgrounds.get(request.id);
          if (child?.creator === request.creator) {
            this.end(child);
          }

          continue;
        }

        const { job } = request;
        const creator = this.backgrounds.get(job.creator);
        if (!creator) {
          // Its maker has ended.
          continue;
        }

        for (const p of job.shared) {
          try {
            const value = this.unpacked(p.value);
            this.applyShared({ type: "shared", worker: p.worker, key: p.key, value });
          } catch (error) {
            this.s.reportUncaught(error);
          }
        }

        this.createFor(creator, job.id, job.swf);
      }
    } finally {
      this.servicing = false;
    }
  }

  /** Start worker `id`, which background worker `creator` made to run `swf`. */
  private createFor(creator: Background, id: number, swf: Uint8Array<ArrayBuffer>): void {
    avm2.syncOf(this.s.rt).addThread(id);
    const child: Background = {
      id,
      creator: creator.id,
      swf,
      state: "new",
      thread: null,
      pending: [],
      sent: 0,
      waits: [],
    };
    this.backgrounds.set(id, child);
    try {
      this.start(id);
    } catch (error) {
      this.s.reportUncaught(error);
    }
  }

  /** Tell the background worker that made `background` its state. */
  private toCreator(background: Background, state: "running" | "terminated"): void {
    const creator = background.creator === null ? null : this.backgrounds.get(background.creator);
    if (creator && !this.parent) {
      this.post(creator, { type: "state", worker: background.id, state });
    }
  }

  /** Stop its thread, and let go of what it held: its SWF, its shared properties, its channels. */
  private end(background: Background): void {
    const id = background.id;
    if (background.state === "terminated") {
      return;
    }

    this.toCreator(background, "terminated");
    background.state = "terminated";
    const thread = background.thread;
    background.thread = null;
    background.pending.length = 0;
    background.swf = new Uint8Array(0);
    for (const w of background.waits.splice(0)) {
      w.done();
    }

    this.backgrounds.delete(id);
    this.ended.add(id);
    const sync = avm2.syncOf(this.s.rt);
    if (sync.shared && !this.parent) {
      sync.updateTable((bytes) => packTable(unpackTable(bytes).filter((e) => e.worker !== id)));
    }

    // No notify picks it, and while its thread runs on the shared memory
    // refuses it anything more; the Mutexes it holds are let go once its
    // thread has stopped. Only the primordial runs the thread.
    sync.stop(id);
    if (!this.parent) {
      if (thread) {
        stopThread(sync, id, thread);
      } else {
        sync.end(id);
      }
    }

    this.shared.delete(id);
    // A channel's AS3 objects keep theirs; nothing more is routed to it.
    for (const [key, channel] of this.channels) {
      if (channel.ref.sender === id || channel.ref.receiver === id) {
        channel.undelivered = 0;
        if (channel.ref.queue !== 0 && !sync.terminated) {
          // What it had not taken, or would have, goes with it.
          sync.close(channel.ref.queue);
          while (sync.shift(channel.ref.queue) !== null) {
            // Each entry freed.
          }
        }

        this.channels.delete(key);
      }
    }

    this.stateChanged(id, true);
  }

  private post(background: Background, message: ToWorker): void {
    if (background.state === "terminated") {
      return;
    }

    if (!background.thread) {
      background.pending.push(message);
      return;
    }

    background.thread.post(message);
    background.sent++;
    this.wait(background, background.sent);
  }

  /**
   * Have settled() wait until the thread has run its first `upTo` messages,
   * or is blocked in a lock or a wait, which only another worker ends: it
   * runs no frame meanwhile to say it has run them.
   */
  private wait(background: Background, upTo: number): void {
    const sync = avm2.syncOf(this.s.rt);
    this.s.loads.trackRequest(
      new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const done = () => {
          if (timer !== null) {
            clearInterval(timer);
          }

          resolve();
        };
        if (sync.shared) {
          timer = setInterval(() => {
            if (sync.blocked(background.id)) {
              done();
            }
          }, 5);
        }

        background.waits.push({ upTo, done });
      }),
    );
  }

  private applyShared(message: SharedMessage): void {
    if (message.value?.kind === "shared") {
      this.memories.set(message.value.memory.id, message.value.memory);
    }

    const own = this.propertiesOf(message.worker);
    if (message.value === null) {
      own.delete(message.key);
    } else {
      own.set(message.key, { wire: message.value, local: undefined });
    }
  }

  private propertiesOf(id: number): Map<string | null, Shared> {
    let own = this.shared.get(id);
    if (!own) {
      own = new Map();
      this.shared.set(id, own);
    }

    return own;
  }

  private channel(ref: ChannelRef): Channel {
    let channel = this.channels.get(ref.id);
    if (!channel) {
      channel = { ref, state: "open", queue: [], undelivered: 0, object: null };
      this.channels.set(ref.id, channel);
    }

    return channel;
  }

  private channelObject(ref: ChannelRef): AsObject {
    const channel = this.channel(ref);
    if (!channel.object) {
      const rt = this.s.rt;
      const o = rt.constructClass(rt.classNamed("flash.system::MessageChannel"), []) as AsObject;
      o.$channel = channel;
      channel.object = o;
    }

    return channel.object;
  }

  private channelOf(o: AsObject): Channel {
    return o.$channel as Channel;
  }

  /** A value as it crosses to another worker: only the top value is looked at, as in avmplus. */
  private encode(value: Value): WireValue {
    const rt = this.s.rt;
    if (value === null || typeof value !== "object") {
      return { kind: "value", value: value as number | boolean | string | null };
    }

    if (value.$channel) {
      return { kind: "channel", channel: (value.$channel as Channel).ref };
    }

    if (rt.isInstance(value, rt.classNamed("flash.utils::ByteArray"))) {
      const bytes = avm2.bytesOf(rt, value);
      // Its memory, shared from now on; on a page that is not cross-origin
      // isolated, the error that says so rather than a copy nobody writes.
      if (bytes.shareable) {
        const memory = bytes.share();
        this.memories.set(memory.id, memory);
        return { kind: "shared", memory };
      }

      return { kind: "bytes", bytes: bytes.buffer.slice(0, bytes.length) };
    }

    // By reference, as an address in the memory every worker has; on a page
    // that is not cross-origin isolated, the error that says it needs it.
    const ref = avm2.syncRef(value);
    if (ref) {
      if (!avm2.syncOf(rt).shared) {
        throw avm2.notIsolated(ref.kind === "mutex" ? "a Mutex" : "a Condition");
      }

      return { kind: "sync", ref };
    }

    const holder = rt.construct(rt.classNamed("flash.utils::ByteArray")) as AsObject;
    const bytes = avm2.bytesOf(rt, holder);
    new avm2.Amf3Writer(rt, bytes).value(value);
    return { kind: "amf", bytes: bytes.buffer.slice(0, bytes.length) };
  }

  private decode(wire: WireValue): Value {
    const rt = this.s.rt;
    switch (wire.kind) {
      case "value":
        return wire.value;
      case "channel":
        return this.channelObject(wire.channel);
      case "sync":
        return avm2.syncObject(rt, wire.ref);
      case "shared":
        this.memories.set(wire.memory.id, wire.memory);
        return avm2.sharedByteArray(rt, wire.memory);
      case "bytes":
      case "amf": {
        const holder = rt.construct(rt.classNamed("flash.utils::ByteArray")) as AsObject;
        const bytes = avm2.bytesOf(rt, holder);
        bytes.write(wire.bytes);
        bytes.position = 0;
        return wire.kind === "bytes" ? holder : new avm2.Amf3Reader(rt, bytes).value();
      }
    }
  }
}
