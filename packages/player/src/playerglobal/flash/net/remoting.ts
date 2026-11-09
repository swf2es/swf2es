// Flash Remoting's packets for AS3's NetConnection.call, as adl sends and
// reads them. A packet is its version (0, or 3 where the connection's
// objectEncoding is AMF3), its headers and its calls, each call's
// arguments a strict array. In AMF0 every value is AMF0, the arguments
// sharing one table of references whose first object is 0. In AMF3 the
// strings, numbers, booleans, null and undefined are still AMF0, and every
// other value is AMF0's 0x11 followed by AMF3, the arguments of a call
// sharing one AMF3 writer's tables; a header's value is one of its own.
import { avm2 } from "@swf2es/runtime";
import * as A from "../../../avm1/amf.js";
import { Amf0Reader, Amf0Writer, AVMPLUS } from "./local-values.js";

type Value = avm2.Value;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A header: its name, whether the server must understand it, its value's bytes. */
export interface RemoteHeader {
  readonly name: string;
  readonly mustUnderstand: boolean;
  readonly value: Uint8Array;
}

/** A call waiting for the frame's packet: its method, its number, its arguments' bytes. */
export interface RemoteCall {
  readonly method: string;
  readonly id: number;
  readonly body: Uint8Array;
}

/** Whether AMF3 writes `v` as AMF0 all the same: what has no AMF3 reference to share. */
function primitive(v: Value): boolean {
  return (
    v === null || (typeof v !== "object" && typeof v !== "function") || v instanceof avm2.FloatValue
  );
}

/** `v`, a primitive, in AMF0 at the end of `out`. */
function writeAmf0Primitive(out: avm2.Bytes, v: Value): void {
  const w = new A.Writer(() => null, 8, null, null);
  w.value(v instanceof avm2.FloatValue ? v.value : (v as number | string | boolean | null));
  out.write(w.finish());
}

/** AMF3 values, each after 0x11, into one buffer, sharing one AMF3 writer's tables. */
class Amf3Values {
  readonly bytes: avm2.Bytes;
  private readonly writer: avm2.Amf3Writer;

  constructor(rt: avm2.Runtime) {
    this.bytes = new avm2.Bytes(rt, {});
    this.writer = new avm2.Amf3Writer(rt, this.bytes);
  }

  value(v: Value): void {
    if (primitive(v)) {
      writeAmf0Primitive(this.bytes, v);
      return;
    }

    this.bytes.write(Uint8Array.of(AVMPLUS));
    this.writer.value(v);
  }

  finish(): Uint8Array {
    return this.bytes.buffer.slice(0, this.bytes.length);
  }
}

/** A header's value: AMF0, itself its table's first object; or in AMF3, with tables of its own. */
export function remoteValue(rt: avm2.Runtime, v: Value, encoding: number): Uint8Array {
  if (encoding === 3) {
    const w = new Amf3Values(rt);
    w.value(v);
    return w.finish();
  }

  const w = new Amf0Writer(rt, Number.POSITIVE_INFINITY, 0, "Remoting");
  w.value(v);
  return w.out.finish();
}

/** A call's arguments: a strict array of them, in the connection's encoding. */
export function remoteArguments(rt: avm2.Runtime, args: Value[], encoding: number): Uint8Array {
  if (encoding === 3) {
    const w = new Amf3Values(rt);
    const head = new Uint8Array(5);
    head[0] = A.STRICT_ARRAY;
    new DataView(head.buffer).setUint32(1, args.length);
    w.bytes.write(head);
    for (const v of args) {
      w.value(v);
    }

    return w.finish();
  }

  const w = new Amf0Writer(rt, Number.POSITIVE_INFINITY, 0, "Remoting");
  w.out.bytes(A.STRICT_ARRAY);
  w.out.u32(args.length);
  for (const v of args) {
    w.value(v);
  }

  return w.out.finish();
}

/** Bytes, joined once. */
function join(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }

  return out;
}

/** A u16-long UTF-8 string, no marker. */
function utf(text: string): Uint8Array {
  const b = encoder.encode(text).subarray(0, 0xffff);
  return join([Uint8Array.of(b.length >> 8, b.length & 0xff), b]);
}

const u16 = (n: number) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
const u32 = (n: number) =>
  Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

/** A packet of the calls, each answered at /n, its number on the connection. */
export function remotePacket(
  encoding: number,
  headers: readonly RemoteHeader[],
  calls: readonly RemoteCall[],
): Uint8Array {
  const out: Uint8Array[] = [u16(encoding === 3 ? 3 : 0), u16(headers.length)];
  for (const h of headers) {
    out.push(utf(h.name), Uint8Array.of(h.mustUnderstand ? 1 : 0), u32(h.value.length), h.value);
  }

  out.push(u16(calls.length));
  for (const call of calls) {
    out.push(utf(call.method), utf(`/${call.id}`), u32(call.body.length), call.body);
  }

  return join(out);
}

/**
 * An answer's messages, their targets and values; "version" for one that
 * is no packet of version 0 or 3, which Flash reports as BadVersion.
 * Each value is read on its own, AMF3 after 0x11 included; a message's
 * length, where it gives one, says where the next begins.
 */
export function remoteMessages(
  rt: avm2.Runtime,
  bytes: Uint8Array,
): [target: string, value: Value][] | "version" {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const version = view.getUint16(0);
    if (version !== 0 && version !== 3) {
      return "version";
    }

    let at = 2;
    const text = (): string => {
      const n = view.getUint16(at);
      at += 2;
      if (at + n > bytes.length) {
        throw new RangeError("past the end");
      }

      const s = decoder.decode(bytes.subarray(at, at + n));
      at += n;
      return s;
    };
    const value = (): Value => {
      const length = view.getUint32(at);
      at += 4;
      const start = at;
      const reader = new Amf0Reader(rt, bytes, at, true, "Remoting");
      const v = reader.value();
      at = length !== 0xffffffff && start + length <= bytes.length ? start + length : reader.at;
      return v;
    };
    const headers = view.getUint16(at);
    at += 2;
    for (let i = 0; i < headers; i++) {
      text();
      at += 1;
      value();
    }

    const count = view.getUint16(at);
    at += 2;
    const messages: [string, Value][] = [];
    for (let i = 0; i < count; i++) {
      const target = text();
      text();
      messages.push([target, value()]);
    }

    return messages;
  } catch {
    return "version";
  }
}
