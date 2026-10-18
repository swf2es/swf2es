// NetConnection's AS2 face, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/netconnection.rs and core/src/net_connection.rs
// have it: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors. connect(null) is the local connection, connected at once;
// an http or https URL is Flash Remoting: each call is queued, and the
// frame's calls go together as one AMF0 packet POSTed to the URL, the
// connection's headers with them, each call's answer, /n/onResult or
// /n/onStatus, going to its responder. Any other URL connects nothing.
import { avm1 } from "@swf2es/runtime";
import { ECMA_ARRAY, OBJECT_END, Reader, STRICT_ARRAY, Writer } from "../amf.js";
import type { Avm1Net } from "../net.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** What NetConnection asks of the player. */
export interface NetConnectionHost {
  readonly realm: avm1.Realm;
  readonly version: number;
  readonly net: Avm1Net;
  /** `o[name](...args)` in the root's activation. */
  callback(o: Obj, name: string, args: Value[]): void;
  /** The name Object.registerClass gave `constr`, which AMF0 writes an object of as typed; null for none. */
  registeredName(constr: Value): string | null;
  /** An XML node's text, as its toString gives it; null for anything else. */
  xmlText(o: Obj): string | null;
}

/** A remoting header: its name, whether the server must understand it, its AMF0 value. */
interface Header {
  readonly name: string;
  readonly mustUnderstand: boolean;
  readonly value: Uint8Array;
}

/** A call waiting for the frame's packet: its method, its arguments' AMF0, who answers. */
interface Call {
  readonly method: string;
  readonly args: Uint8Array;
  readonly responder: Obj | null;
}

/** A connection: the local one, or Flash Remoting's to `url`. */
interface Connection {
  readonly self: Obj;
  readonly url: string | null;
  headers: Header[];
  queue: Call[];
}

const encoder = new TextEncoder();

/** Bytes, joined once. */
function join(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }

  return out;
}

/** How an XML node's text is had, which a remoting value writes as XML. */
type Xml = { xmlText(o: Obj): string | null };

/** A value's AMF0 as a remoting call writes an argument or a header (Ruffle's amf.rs serialize). */
export function remotingValue(
  v: Value,
  typedName: (constr: Value) => string | null,
  version: number,
  xml: Xml,
): Uint8Array {
  const w = new Writer(typedName, version, null, xml);
  writeTop(w, v, typedName, version, xml);
  return join(w.chunks);
}

/**
 * A value at the top of an argument: an array as a strict array of its
 * elements, each again at the top, or, with a key that is no index, as an
 * ECMA array of every key; an object without the references its own
 * properties count, which start afresh for each.
 */
function writeTop(
  w: Writer,
  v: Value,
  typedName: (constr: Value) => string | null,
  version: number,
  xml: Xml,
): void {
  if (!(v instanceof avm1.Avm1Object) || v.display !== null || !v.array) {
    if (v instanceof avm1.Avm1Object) {
      w.root(v);
    } else {
      w.value(v);
    }

    return;
  }

  // A getter that throws, length's or an element's, gives 0 or undefined (Ruffle).
  const read = (name: string): Value => {
    try {
      return avm1.get(v, name, version);
    } catch (error) {
      if (error instanceof avm1.Avm1Throw) {
        return undefined;
      }

      throw error;
    }
  };
  const keys = avm1.keys(v, version);
  let length = Math.max(0, avm1.toNumber(read("length"), version) | 0);
  let custom = false;
  for (const key of keys) {
    if (/^\d+$/.test(key)) {
      length = Math.max(length, Number(key) + 1);
    } else {
      custom = true;
    }
  }

  const element = (value: Value) => {
    const inner = new Writer(typedName, version, null, xml);
    writeTop(inner, value, typedName, version, xml);
    for (const chunk of inner.chunks) {
      w.push(chunk);
    }
  };
  if (custom) {
    w.bytes(ECMA_ARRAY);
    w.u32(length);
    for (const key of keys.reverse()) {
      w.name(key);
      element(read(key));
    }

    w.bytes(0, 0, OBJECT_END);
    return;
  }

  w.bytes(STRICT_ARRAY);
  w.u32(length);
  for (let i = 0; i < length; i++) {
    element(read(String(i)));
  }
}

/** A u16-long UTF-8 string, no marker. */
function utf(text: string): Uint8Array {
  const b = encoder.encode(text).subarray(0, 0xffff);
  return join([Uint8Array.of(b.length >> 8, b.length & 0xff), b]);
}

const u16 = (n: number) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
const u32 = (n: number) =>
  Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

/** An AMF0 remoting packet: version 0, the headers, the calls, each answered at /1, /2... */
function packet(headers: Header[], calls: Call[]): Uint8Array {
  const out: Uint8Array[] = [u16(0), u16(headers.length)];
  for (const h of headers) {
    out.push(utf(h.name), Uint8Array.of(h.mustUnderstand ? 1 : 0), u32(h.value.length), h.value);
  }

  out.push(u16(calls.length));
  calls.forEach((call, i) => {
    out.push(utf(call.method), utf(`/${i + 1}`), u32(call.args.length), call.args);
  });
  return join(out);
}

/** A packet's messages' targets and values read, null where it is no packet. */
function messagesOf(
  bytes: Uint8Array,
  realm: avm1.Realm,
  version: number,
): [target: string, value: Value][] | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 2;
    const text = () => {
      const n = view.getUint16(at);
      at += 2;
      if (at + n > bytes.length) {
        throw new RangeError("past the end");
      }

      const s = new TextDecoder().decode(bytes.subarray(at, at + n));
      at += n;
      return s;
    };
    const value = () => {
      const reader = new Reader(bytes.subarray(at), realm, version);
      const v = reader.value();
      at += reader.at;
      return v;
    };
    const headers = view.getUint16(at);
    at += 2;
    for (let i = 0; i < headers; i++) {
      text();
      at += 5;
      value();
    }

    const count = view.getUint16(at);
    at += 2;
    const messages: [string, Value][] = [];
    for (let i = 0; i < count; i++) {
      const target = text();
      text();
      at += 4;
      messages.push([target, value()]);
    }

    return messages;
  } catch {
    return null;
  }
}

/** The connections open and their calls, sent a packet each at the end of a frame. */
export class Remoting {
  private readonly connections = new Map<Obj, Connection>();

  constructor(private readonly host: NetConnectionHost) {}

  /** A frame's end: each connection's calls sent as one packet. */
  flush(): void {
    for (const c of this.connections.values()) {
      if (c.url === null || c.queue.length === 0) {
        continue;
      }

      const calls = c.queue;
      c.queue = [];
      const body = packet(c.headers, calls);
      this.host.net.fetch(
        {
          url: c.url,
          method: "POST",
          headers: [["Content-Type", "application/x-amf"]],
          body,
        },
        (result) => this.answered(c, calls, result.bytes),
      );
    }
  }

  private answered(c: Connection, calls: Call[], bytes: Uint8Array | null): void {
    const host = this.host;
    if (bytes === null) {
      // A failed request: the connection's onStatus with nothing, if it is still open.
      if (this.connections.get(c.self) === c) {
        host.callback(c.self, "onStatus", []);
      }

      return;
    }

    // Flash ignores an answer that is no packet.
    for (const [target, value] of messagesOf(bytes, host.realm, host.version) ?? []) {
      const m = /^\/(\d+)\/(onResult|onStatus)$/.exec(target);
      const responder = m ? calls[Number(m[1]) - 1]?.responder : null;
      if (m && responder) {
        host.callback(responder, m[2], [value]);
      }
    }
  }

  connection(self: Obj): Connection | undefined {
    return this.connections.get(self);
  }

  /** `self` connected to `url`, local for null; the connection it had closed first. */
  open(self: Obj, url: string | null): void {
    if (this.connections.has(self)) {
      this.close(self, false);
    }

    this.connections.set(self, { self, url, headers: [], queue: [] });
    if (url === null) {
      this.status(self, "NetConnection.Connect.Success");
    }
  }

  /** `self`'s connection closed: Closed, and where a script closed remoting, onStatus with nothing. */
  close(self: Obj, explicit: boolean): void {
    const c = this.connections.get(self);
    if (c === undefined) {
      return;
    }

    this.connections.delete(self);
    this.status(self, "NetConnection.Connect.Closed");
    if (explicit && c.url !== null) {
      this.host.callback(self, "onStatus", []);
    }
  }

  private status(self: Obj, code: string): void {
    const { realm, version } = this.host;
    const event = realm.newObject(version);
    avm1.set(event, "code", code, version);
    avm1.set(event, "level", "status", version);
    this.host.callback(self, "onStatus", [event]);
  }
}

/** `NetConnection`. */
export function netConnectionClass(host: NetConnectionHost, remoting: Remoting): Obj {
  const realm = host.realm;
  const made = new WeakSet<Obj>();
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self) => {
      made.add(self);
      return self;
    },
    () => undefined,
  );
  const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE;
  const typedName = (c: Value) => host.registeredName(c);
  // A subclass's `super.call(...)` is the connection's call: super's `this` is it.
  const connectionOf = (self: Obj): Obj | null => {
    const o = self instanceof avm1.Avm1Super ? self.self : self;
    return made.has(o) ? o : null;
  };
  const getter = (name: string, get: (c: Connection | undefined) => Value) => {
    const p = proto.add(name, undefined, 0);
    p.get = realm.method((self) => {
      const o = connectionOf(self);
      return o === null ? undefined : get(remoting.connection(o));
    });
  };
  const method = (name: string, f: (self: Obj, args: Value[], v: number) => void) =>
    proto.define(
      name,
      realm.method((self, args, v) => {
        const o = connectionOf(self);
        if (o !== null) {
          f(o, args, v);
        }

        return undefined;
      }),
      FIXED,
    );

  getter("protocol", (c) => (c !== undefined && c.url === null ? "rtmp" : undefined));
  method("connect", (self, args, v) => {
    const url = args[0];
    if (url === undefined || url === null) {
      remoting.open(self, null);
      return;
    }

    const text = avm1.stringOf(url, v);
    if (/^https?:\/\//i.test(text)) {
      remoting.open(self, text);
    }
  });
  method("close", (self) => remoting.close(self, true));
  method("call", (self, args, v) => {
    const method = avm1.stringOf(args[0], v);
    const values = args.slice(2);
    const c = remoting.connection(self);
    if (c === undefined) {
      return;
    }

    const parts: Uint8Array[] = [Uint8Array.of(STRICT_ARRAY), u32(values.length)];
    for (const value of values) {
      parts.push(remotingValue(value, typedName, v, host));
    }

    const responder =
      args.length > 1 ? (args[1] instanceof avm1.Avm1Object ? args[1] : realm.newObject(v)) : null;
    if (c.url !== null) {
      c.queue.push({ method, args: join(parts), responder });
    }
  });
  method("addHeader", (self, args, v) => {
    const name = avm1.stringOf(args[0], v);
    const mustUnderstand = args.length > 1 ? avm1.toBoolean(args[1], v) : true;
    const value = remotingValue(args.length > 2 ? args[2] : null, typedName, v, host);
    const c = remoting.connection(self);
    if (c !== undefined) {
      // One header of a name, its case aside: the last set.
      c.headers = c.headers.filter((h) => h.name.toLowerCase() !== name.toLowerCase());
      c.headers.push({ name, mustUnderstand, value });
    }
  });
  getter("isConnected", (c) => c !== undefined && c.url === null);
  getter("uri", (c) => (c === undefined ? undefined : (c.url ?? "null")));
  return constr;
}
