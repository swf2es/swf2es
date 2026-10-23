// flash.system's workers as one VM sees them (docs/workers.md): the
// primordial starts each background worker on a thread of its host's and
// routes what crosses between them; a background worker's VM reaches only
// the primordial. Shared properties and channels' messages cross as copies,
// made as avmplus' ChannelItem makes them, so a host's channel carries
// plain data. Without shared memory each side keeps its own copy of a
// worker's shared properties, and what one side sets reaches the other
// between its frames.
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

/** A background worker the primordial made. */
interface Background {
  id: number;
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

/** A MessageChannel as this VM knows it: its queue is the receiver's. */
interface Channel {
  ref: ChannelRef;
  state: "open" | "closing" | "closed";
  queue: WireValue[];
  /**
   * Sent from the primordial to a background worker that has not yet run
   * a frame since: what messageAvailable sees on the sending side, which
   * cannot see the receiver's queue without shared memory.
   */
  undelivered: number;
  /** Its AS3 object in this VM, made when a script first has it. */
  object: AsObject | null;
}

/** A shared property: what crosses, and the value itself where it reads back as itself. */
interface Shared {
  wire: WireValue;
  local: Value;
}

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
  private nextWorker = 1;
  private nextChannel = 1;
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

    if (this.parent || !this.host) {
      throw rt.unsupported(
        this.parent
          ? "creating a Worker from a background worker"
          : "creating a Worker without a worker host",
      );
    }

    const bytes = avm2.bytesOf(rt, swf as AsObject);
    const id = this.nextWorker++;
    this.backgrounds.set(id, {
      id,
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

    if (this.parent) {
      // A worker may end itself; the primordial stops its thread.
      if (id !== this.id) {
        return false;
      }

      this.parent.post({ type: "terminate" });
      return true;
    }

    const background = this.backgrounds.get(id);
    if (!background || background.state === "new" || background.state === "terminated") {
      return false;
    }

    this.end(background);
    return true;
  }

  state(id: number): string {
    if (id === this.id || id === PRIMORDIAL) {
      return "running";
    }

    return STATES[this.backgrounds.get(id)?.state ?? "terminated"];
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
      if (to !== from && (message.worker === PRIMORDIAL || message.worker === to)) {
        // One not started gets it with the rest when it starts.
        if (background.state !== "new") {
          this.post(background, message);
        }
      }
    }
  }

  getShared(id: number, key: string | null): Value {
    const p = this.shared.get(id)?.get(key);
    if (!p) {
      return undefined;
    }

    return p.local !== undefined ? p.local : this.decode(p.wire);
  }

  /** Worker.createMessageChannel: a channel from `sender` to `receiver`. */
  createChannel(sender: number, receiver: number): AsObject {
    // Ids made by a background worker are its own, apart from the primordial's.
    const id = this.id * 0x100000 + this.nextChannel++;
    return this.channelObject({ id, sender, receiver });
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

    this.route({ type: "message", channel: channel.ref, value: this.encode(value) }, this.id);
  }

  receive(o: AsObject, block: boolean): Value {
    const rt = this.s.rt;
    const channel = this.channelOf(o);
    if (channel.ref.receiver !== this.id) {
      throw rt.error("ArgumentError", 3737);
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

  messageAvailable(o: AsObject): boolean {
    const channel = this.channelOf(o);
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

    this.route({ type: "close", channel: channel.ref, drained: false }, this.id);
    this.closed(channel);
  }

  /** Stop every background worker's thread, as the player goes. */
  stopAll(): void {
    for (const background of this.backgrounds.values()) {
      if (background.state !== "new" && background.state !== "terminated") {
        this.end(background);
      }
    }
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
          if (message.type === "message") {
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

    channel.queue.push(message.value);
    this.s.loads.deferHostEvent(() => this.dispatch(channel, "channelMessage"));
  }

  /**
   * This end closed, by itself or by the other: closing until the
   * receiver's queue is empty, which only the receiver sees, so a sender on
   * another worker is closing until the receiver tells it (drained).
   */
  private closed(channel: Channel): void {
    const receiving = channel.ref.receiver === this.id;
    channel.state = receiving && channel.queue.length === 0 ? "closed" : "closing";
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

  /** Stop its thread, and let go of what it held: its SWF, its shared properties, its channels. */
  private end(background: Background): void {
    const id = background.id;
    background.state = "terminated";
    background.thread?.terminate();
    background.thread = null;
    background.pending.length = 0;
    background.swf = new Uint8Array(0);
    for (const w of background.waits.splice(0)) {
      w.done();
    }

    this.backgrounds.delete(id);
    this.ended.add(id);
    this.shared.delete(id);
    // A channel's AS3 objects keep theirs; nothing more is routed to it.
    for (const [key, channel] of this.channels) {
      if (channel.ref.sender === id || channel.ref.receiver === id) {
        channel.undelivered = 0;
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

  /** Have settled() wait until the thread has run its first `upTo` messages. */
  private wait(background: Background, upTo: number): void {
    this.s.loads.trackRequest(new Promise<void>((done) => background.waits.push({ upTo, done })));
  }

  private applyShared(message: SharedMessage): void {
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
      return { kind: "bytes", bytes: bytes.buffer.slice(0, bytes.length) };
    }

    for (const name of ["flash.concurrent::Mutex", "flash.concurrent::Condition"]) {
      if (rt.isInstance(value, rt.classNamed(name))) {
        throw rt.unsupported(`passing a ${name.slice(name.indexOf("::") + 2)} to another worker`);
      }
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
