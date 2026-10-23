// A WireValue as bytes, for a channel's queue in the memory the workers
// share (docs/workers.md): what a worker blocked in receive(true) takes
// without returning to its event loop, so nothing in it may be memory
// only a posted message could bring. A Mutex, a Condition and a channel
// are addresses in the shared heap, which every worker has; a shareable
// ByteArray's memory goes by its id, and comes to each worker with the
// message's notice.
import type { ChannelRef, WireValue } from "./protocol.js";

/** A WireValue as it is queued: a shareable ByteArray's memory by its id. */
export type PackedValue =
  | Exclude<WireValue, { kind: "shared" }>
  | { kind: "shared"; id: number; memory?: undefined };

const NUMBER = 0;
const TRUE = 1;
const FALSE = 2;
const STRING = 3;
const NULL = 4;
const AMF = 5;
const BYTES = 6;
const SHARED = 7;
const CHANNEL = 8;
const MUTEX = 9;
const CONDITION = 10;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function tagged(tag: number, length: number): { out: Uint8Array; view: DataView } {
  const out = new Uint8Array(1 + length);
  out[0] = tag;
  return { out, view: new DataView(out.buffer) };
}

function withBytes(tag: number, bytes: Uint8Array): Uint8Array {
  const { out } = tagged(tag, bytes.length);
  out.set(bytes, 1);
  return out;
}

export function pack(wire: WireValue): Uint8Array {
  switch (wire.kind) {
    case "value": {
      const v = wire.value;
      if (v === null) {
        return tagged(NULL, 0).out;
      }

      if (typeof v === "boolean") {
        return tagged(v ? TRUE : FALSE, 0).out;
      }

      if (typeof v === "string") {
        return withBytes(STRING, encoder.encode(v));
      }

      const { out, view } = tagged(NUMBER, 8);
      view.setFloat64(1, v, true);
      return out;
    }
    case "amf":
      return withBytes(AMF, wire.bytes);
    case "bytes":
      return withBytes(BYTES, wire.bytes);
    case "shared": {
      const { out, view } = tagged(SHARED, 8);
      view.setFloat64(1, wire.memory.id, true);
      return out;
    }
    case "channel": {
      const { out, view } = tagged(CHANNEL, 20);
      view.setFloat64(1, wire.channel.id, true);
      view.setInt32(9, wire.channel.sender, true);
      view.setInt32(13, wire.channel.receiver, true);
      view.setInt32(17, wire.channel.queue, true);
      return out;
    }
    case "sync": {
      const { out, view } = tagged(wire.ref.kind === "mutex" ? MUTEX : CONDITION, 4);
      view.setInt32(1, wire.ref.address, true);
      return out;
    }
  }
}

export function unpack(bytes: Uint8Array): PackedValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rest = () => bytes.slice(1);
  switch (bytes[0]) {
    case NUMBER:
      return { kind: "value", value: view.getFloat64(1, true) };
    case TRUE:
    case FALSE:
      return { kind: "value", value: bytes[0] === TRUE };
    case STRING:
      return { kind: "value", value: decoder.decode(bytes.subarray(1)) };
    case NULL:
      return { kind: "value", value: null };
    case AMF:
      return { kind: "amf", bytes: rest() };
    case BYTES:
      return { kind: "bytes", bytes: rest() };
    case SHARED:
      return { kind: "shared", id: view.getFloat64(1, true) };
    case CHANNEL: {
      const channel: ChannelRef = {
        id: view.getFloat64(1, true),
        sender: view.getInt32(9, true),
        receiver: view.getInt32(13, true),
        queue: view.getInt32(17, true),
      };
      return { kind: "channel", channel };
    }
    default:
      return {
        kind: "sync",
        ref: { kind: bytes[0] === MUTEX ? "mutex" : "condition", address: view.getInt32(1, true) },
      };
  }
}

/** A shared property as the table in shared memory keeps it. */
export interface TableEntry {
  worker: number;
  key: string | null;
  /** Unique to this set, by which a worker knows the value it set itself. */
  token: number;
  value: Uint8Array;
}

export function packTable(entries: Iterable<TableEntry>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const key = e.key === null ? null : encoder.encode(e.key);
    const head = new DataView(new ArrayBuffer(16));
    head.setInt32(0, e.worker, true);
    head.setInt32(4, key === null ? -1 : key.length, true);
    head.setInt32(8, e.token, true);
    head.setUint32(12, e.value.length, true);
    parts.push(new Uint8Array(head.buffer), key ?? new Uint8Array(0), e.value);
  }

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }

  return out;
}

export function unpackTable(bytes: Uint8Array): TableEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: TableEntry[] = [];
  let at = 0;
  while (at < bytes.length) {
    const worker = view.getInt32(at, true);
    const keyLength = view.getInt32(at + 4, true);
    const token = view.getInt32(at + 8, true);
    const valueLength = view.getUint32(at + 12, true);
    at += 16;
    const key = keyLength < 0 ? null : decoder.decode(bytes.subarray(at, at + keyLength));
    at += Math.max(keyLength, 0);
    entries.push({ worker, key, token, value: bytes.slice(at, at + valueLength) });
    at += valueLength;
  }

  return entries;
}

/**
 * A worker a background worker made, for the primordial to start: its
 * number, its maker's, its SWF, and its shared properties as its maker
 * had them, which the maker's own messages may not have brought yet.
 */
export interface Job {
  id: number;
  creator: number;
  swf: Uint8Array<ArrayBuffer>;
  shared: { worker: number; key: string | null; value: PackedValue }[];
}

export function packJob(
  id: number,
  creator: number,
  swf: Uint8Array,
  shared: { worker: number; key: string | null; value: WireValue }[],
): Uint8Array {
  const head = new DataView(new ArrayBuffer(16));
  head.setInt32(0, id, true);
  head.setInt32(4, creator, true);
  head.setUint32(8, swf.length, true);
  head.setUint32(12, shared.length, true);
  const parts: Uint8Array[] = [new Uint8Array(head.buffer), swf];
  for (const p of shared) {
    const key = p.key === null ? null : encoder.encode(p.key);
    const value = pack(p.value);
    const entry = new DataView(new ArrayBuffer(12));
    entry.setInt32(0, p.worker, true);
    entry.setInt32(4, key === null ? -1 : key.length, true);
    entry.setUint32(8, value.length, true);
    parts.push(new Uint8Array(entry.buffer), key ?? new Uint8Array(0), value);
  }

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }

  return out;
}

export function unpackJob(bytes: Uint8Array): Job {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const swfLength = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  let at = 16 + swfLength;
  const shared: Job["shared"] = [];
  for (let i = 0; i < count; i++) {
    const worker = view.getInt32(at, true);
    const keyLength = view.getInt32(at + 4, true);
    const valueLength = view.getUint32(at + 8, true);
    at += 12;
    const key = keyLength < 0 ? null : decoder.decode(bytes.subarray(at, at + keyLength));
    at += Math.max(keyLength, 0);
    shared.push({ worker, key, value: unpack(bytes.slice(at, at + valueLength)) });
    at += valueLength;
  }

  return {
    id: view.getInt32(0, true),
    creator: view.getInt32(4, true),
    swf: bytes.slice(16, 16 + swfLength),
    shared,
  };
}
