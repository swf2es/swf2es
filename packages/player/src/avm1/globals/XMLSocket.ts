// XMLSocket, AS1 and AS2's, as Ruffle's (https://github.com/ruffle-rs/
// ruffle) core/src/avm1/globals/xml_socket.rs and core/src/socket.rs have
// it: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors. It connects through the host's sockets, as AS3's Socket
// and XMLSocket do, so the same hosts serve both: the browser's refusal or
// relay, the desktop app's TCP. Each message either way is a string ended
// by a zero byte; each that comes is given to onData, whose default makes
// an XML of it for onXML. Without a host, or refused, the connection fails
// as Flash's does, with onConnect(false), never an error.
import { avm1 } from "@swf2es/runtime";
import type { SocketTransport } from "../../hosts.js";
import { type Avm1Net, bytesFor, textFor } from "../net.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** The SWF's domain, which a connect without a host goes to: localhost for a file's. */
function swfDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" || !parsed.hostname ? "localhost" : parsed.hostname;
  } catch {
    return "localhost";
  }
}

/** What XMLSocket needs of the movie. */
export interface XmlSocketHost {
  readonly realm: avm1.Realm;
  readonly net: Avm1Net;
  /** The SWF's URL, whose domain a connect without a host goes to. */
  readonly url: string;
  /** The SWF's version, which what comes is read by. */
  readonly version: number;
  /** `o[name](...args)`, as a callback between frames runs it. */
  callback(o: Obj, name: string, args: Value[]): void;
}

interface Connection {
  transport: SocketTransport | null;
  /** Each connect and close starts a new one: events of an older are dropped. */
  generation: number;
  open: boolean;
  /** What was sent before the connection opened, sent as it does. */
  queued: Uint8Array[];
  /** The bytes of a message not yet ended by its zero byte, as they came, and how many. */
  partial: Uint8Array[];
  partialLength: number;
  timeout: number;
}

/**
 * The most a message may hold before its zero byte: a server that never
 * ends one has its connection closed, rather than the player's memory fill.
 */
const MAX_MESSAGE = 16 * 1024 * 1024;

const decoder = new TextDecoder();

/** `_global.XMLSocket`, given `_global.XML`'s constructor, which the default onData makes its XML with. */
export function xmlSocketClass(host: XmlSocketHost, xml: avm1.Avm1Function): avm1.Avm1Function {
  const realm = host.realm;
  const connections = new WeakMap<Obj, Connection>();
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self) => {
      connections.set(self, {
        transport: null,
        generation: 0,
        open: false,
        queued: [],
        partial: [],
        partialLength: 0,
        // Flash's default, 20 seconds.
        timeout: 20000,
      });
      return self;
    },
    () => undefined,
  );
  // Each of them hidden from for..in (adl).
  const HIDDEN = avm1.DONT_ENUM | avm1.DONT_DELETE;
  const method = (name: string, fn: avm1.Native) => proto.define(name, realm.method(fn), HIDDEN);

  /** The connection dropped, from the script's side or either end's: no event of it comes after. */
  const drop = (c: Connection) => {
    c.generation++;
    if (c.transport !== null) {
      host.net.closed(c.transport);
    }

    c.transport = null;
    c.open = false;
    c.queued = [];
    c.partial = [];
    c.partialLength = 0;
  };

  /**
   * `bytes` come: each message they end to onData, while the connection is
   * the one they came on. Only the new bytes are searched for a zero byte;
   * what comes before one waits, up to MAX_MESSAGE.
   */
  const received = (self: Obj, c: Connection, generation: number, bytes: Uint8Array) => {
    let start = 0;
    for (let end = bytes.indexOf(0); end >= 0; end = bytes.indexOf(0, start)) {
      let message: Uint8Array = bytes.subarray(start, end);
      if (c.partialLength > 0) {
        c.partial.push(message);
        message = new Uint8Array(c.partialLength + message.length);
        let at = 0;
        for (const part of c.partial) {
          message.set(part, at);
          at += part.length;
        }

        c.partial = [];
        c.partialLength = 0;
      }

      start = end + 1;
      host.callback(self, "onData", [textFor(decoder.decode(message), host.version)]);
      if (c.generation !== generation) {
        return;
      }
    }

    if (start < bytes.length) {
      c.partial.push(bytes.slice(start));
      c.partialLength += bytes.length - start;
      if (c.partialLength > MAX_MESSAGE) {
        drop(c);
        host.callback(self, "onClose", []);
      }
    }
  };

  const timeout = proto.add("timeout", undefined, HIDDEN);
  timeout.get = realm.method((self) => connections.get(self)?.timeout);
  timeout.set = realm.method((self, args, v) => {
    const c = connections.get(self);
    if (c !== undefined) {
      c.timeout = avm1.toNumber(args[0], v) >>> 0;
    }

    return undefined;
  });
  method("close", (self) => {
    const c = connections.get(self);
    if (c !== undefined && c.transport !== null) {
      drop(c);
    }

    return undefined;
  });
  method("connect", (self, args, v) => {
    const c = connections.get(self);
    if (c === undefined) {
      return undefined;
    }

    const given = args[0];
    const name =
      given === undefined || given === null ? swfDomain(host.url) : avm1.stringOf(given, v);
    // A port out of range is refused, as AS3's Socket refuses it, and nothing connects.
    const port = avm1.toNumber(args[1], v) | 0;
    if (port < 0 || port > 0xffff) {
      return false;
    }

    drop(c);
    const generation = c.generation;
    const current = () => c.generation === generation;
    const failed = () => {
      if (current()) {
        drop(c);
        host.callback(self, "onConnect", [false]);
      }
    };
    c.transport = host.net.connect(
      name,
      port,
      {
        open: () => {
          if (!current()) {
            return;
          }

          c.open = true;
          for (const bytes of c.queued) {
            c.transport?.send(bytes);
          }

          c.queued = [];
          host.callback(self, "onConnect", [true]);
        },
        data: (bytes) => {
          if (current() && c.open) {
            received(self, c, generation, bytes);
          }
        },
        close: () => {
          if (!current()) {
            return;
          }

          if (!c.open) {
            failed();
            return;
          }

          c.generation++;
          c.transport = null;
          c.open = false;
          c.partial = [];
          c.partialLength = 0;
          host.callback(self, "onClose", []);
        },
        error: () => {
          if (!current()) {
            return;
          }

          if (!c.open) {
            failed();
            return;
          }

          drop(c);
          host.callback(self, "onClose", []);
        },
      },
      failed,
      c.timeout,
    );
    // Whether it connects is known only later: true says it was asked.
    return true;
  });
  method("send", (self, args, v) => {
    const c = connections.get(self);
    if (c === undefined || c.transport === null) {
      return undefined;
    }

    const text = bytesFor(avm1.stringOf(args[0], v), v);
    const bytes = new Uint8Array(text.length + 1);
    bytes.set(text);
    if (c.open) {
      c.transport.send(bytes);
    } else {
      c.queued.push(bytes);
    }

    return undefined;
  });
  method("onConnect", () => undefined);
  method("onClose", () => undefined);
  method("onData", (self, args, v) => {
    const document = realm.construct(xml, args, v);
    avm1.invoke(avm1.get(self, "onXML", v), self, [document], v);
    return undefined;
  });
  method("onXML", () => undefined);

  return constr;
}
