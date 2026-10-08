// air.net.WebSocket, AIR 51's client, over the host's WebSocket (hosts.ts).
// What it throws and dispatches is what adl does (docs/architecture.md);
// where a browser cannot do as AIR does, the nearest it can.
import { avm2 } from "@swf2es/runtime";
import type { WebSocketTransport } from "../../../hosts.js";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/**
 * new; connecting; open; closing, after close() or a close frame sent;
 * failed before open, which leaves sends and closes doing nothing, as in
 * AIR; and closed, after which they throw. A WebSocket connects only once.
 */
type State = "new" | "connecting" | "open" | "closing" | "failed" | "closed";

interface Connection {
  state: State;
  url: string;
  transport: WebSocketTransport | null;
  protocol: string | null;
  closeReason: number;
  /** close() was called: AIR dispatches no close for it. */
  closedHere: boolean;
}

const TEXT = 1;
const BINARY = 2;
const CLOSE = 8;

/** The close codes a browser lets a page send. */
const sendable = (code: number) => code === 1000 || (code >= 3000 && code <= 4999);

export function webSocketNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const connections = new WeakMap<AsObject, Connection>();
  const connection = (o: AsObject): Connection => {
    let c = connections.get(o);
    if (!c) {
      c = {
        state: "new",
        url: "",
        transport: null,
        protocol: null,
        closeReason: -1,
        closedHere: false,
      };
      connections.set(o, c);
    }

    return c;
  };
  const byteArray = () => s.rt.classNamed("flash.utils::ByteArray");
  const invalid = (): never => {
    throw s.rt.error("flash.errors::IOError", 2002);
  };
  const errorEvent = (o: AsObject, cls: string, type: string, id: number, text: string) => {
    const event = s.rt.construct(s.rt.classNamed(cls), type, false, false, text, id);
    dispatchEvent(s, o, event);
  };
  // As adl words it: a connection that failed gives its host, a handshake its URL.
  const ioError = (o: AsObject, where: string) =>
    errorEvent(
      o,
      "flash.events::IOErrorEvent",
      "ioError",
      2031,
      `Error #2031: Socket Error.${where && ` URL: ${where}`}`,
    );
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  };

  /** End a connection before its handshake is done, as AIR does when a frame goes out first. */
  const interrupt = (o: AsObject, c: Connection) => {
    c.transport?.close();
    c.transport = null;
    c.state = "closed";
    s.loads.deferHostEvent(() => {
      ioError(o, c.url);
      dispatchEvent(s, o, s.event("close"));
    });
  };

  const send = (c: Connection, opcode: number, bytes: Uint8Array) => {
    const transport = c.transport;
    if (!transport) {
      return;
    }

    // AIR writes the opcode's low four bits, whatever they are.
    switch (opcode & 0x0f) {
      case TEXT:
        // A leading BOM is the SWF's bytes, as AIR sends them, not a mark to drop.
        transport.send(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));
        break;
      case BINARY:
        transport.send(bytes);
        break;
      case CLOSE: {
        // A close frame of the SWF's own: adl sends its code alone, and then
        // dispatches the close, as for the server's.
        const code = bytes.length >= 2 ? (bytes[0] << 8) | bytes[1] : 0;
        c.state = "closing";
        transport.close(sendable(code) ? code : undefined);
        break;
      }
      default:
        // Pings, pongs and reserved opcodes, which AIR sends as they are and a
        // browser cannot: the browser answers the server's pings itself, and
        // AIR dispatches nothing for a pong or for a reserved frame echoed.
        break;
    }
  };

  class WebSocketNatives {
    "air.net:WebSocket::internalConnect"(url: Value, protocols: Value): void {
      if (url === null || url === undefined) {
        throw s.rt.error("TypeError", 2007, "url");
      }

      const c = connection(this);
      if (c.state !== "new") {
        throw s.rt.error("flash.errors::IllegalOperationError", 2082);
      }

      const text = s.rt.toString(url);
      if (!/^wss?:\/\//.test(text)) {
        throw s.rt.error("ArgumentError", 2147, text);
      }

      c.state = "connecting";
      c.url = text;
      // AIR offers the vector's protocols, null ones left out, not `protocol`.
      const offered =
        protocols === null || protocols === undefined
          ? []
          : ((protocols as AsObject).$a as Value[])
              .filter((p) => p !== null && p !== undefined)
              .map((p) => s.rt.toString(p));
      const fail = () => {
        if (c.state !== "connecting") {
          return;
        }

        c.transport = null;
        c.state = "failed";
        ioError(this, hostOf(text));
      };
      const host = s.webSocket;
      if (!host) {
        s.loads.deferHostEvent(fail);
        return;
      }

      try {
        // AIR sends a URL's fragment in its request line; a browser refuses one.
        c.transport = host.connect(text.replace(/#.*$/s, ""), offered, {
          open: (protocol) =>
            s.loads.deferHostEvent(() => {
              if (c.state !== "connecting") {
                return;
              }

              c.state = "open";
              if (protocol !== "") {
                c.protocol = protocol;
              }

              dispatchEvent(s, this, s.event("connect"));
            }),
          message: (data) =>
            s.loads.deferHostEvent(() => {
              if (c.state !== "open" && c.state !== "closing") {
                return;
              }

              const array = s.rt.construct(byteArray());
              const bytes = avm2.bytesOf(s.rt, array);
              bytes.write(typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
              bytes.position = 0;
              const format = typeof data === "string" ? TEXT : BINARY;
              const cls = s.rt.classNamed("flash.events::WebSocketEvent");
              dispatchEvent(s, this, s.rt.construct(cls, "websocketData", format, array));
            }),
          close: (code) =>
            s.loads.deferHostEvent(() => {
              if (c.state === "connecting") {
                fail();
                return;
              }

              if (c.state !== "open" && c.state !== "closing") {
                return;
              }

              c.state = "closed";
              c.transport = null;
              // A close without a frame, or a frame without a code, leaves AIR's -1.
              if (code !== 1005 && code !== 1006) {
                c.closeReason = code;
              }

              if (!c.closedHere) {
                dispatchEvent(s, this, s.event("close"));
              }
            }),
          error: () => s.loads.deferHostEvent(fail),
        });
      } catch (e) {
        if ((e as { name?: unknown } | null)?.name === "SecurityError") {
          c.state = "failed";
          s.loads.deferHostEvent(() =>
            errorEvent(
              this,
              "flash.events::SecurityErrorEvent",
              "securityError",
              2048,
              `Error #2048: Security sandbox violation: ${s.url} cannot load data from ${text}.`,
            ),
          );
        } else {
          s.loads.deferHostEvent(fail);
        }
      }
    }

    sendMessage(opcode: Value, data: Value): void {
      let bytes: Uint8Array;
      if (typeof data === "string") {
        bytes = new TextEncoder().encode(data);
      } else if (data !== null && data !== undefined && s.rt.isInstance(data, byteArray())) {
        const b = avm2.bytesOf(s.rt, data as AsObject);
        bytes = b.buffer.slice(0, b.length);
      } else {
        throw s.rt.error("ArgumentError", 1508, "data");
      }

      const c = connection(this);
      switch (c.state) {
        case "open":
          send(c, s.rt.toUint(opcode), bytes);
          break;
        case "connecting":
          interrupt(this, c);
          break;
        case "new":
        case "closed":
          // Before connect, adl crashes; this is what it throws once closed.
          invalid();
          break;
        default:
          break;
      }
    }

    "air.net:WebSocket::internalClose"(reasonCode: Value): void {
      const c = connection(this);
      switch (c.state) {
        case "open": {
          // AIR sends any code, cut to 16 bits; a browser sends only these.
          const code = s.rt.toUint(reasonCode) & 0xffff;
          c.state = "closing";
          c.closedHere = true;
          c.transport?.close(sendable(code) ? code : undefined);
          break;
        }
        case "connecting":
          interrupt(this, c);
          break;
        case "new":
        case "closed":
          invalid();
          break;
        default:
          break;
      }
    }

    get protocol(): Value {
      return connection(this).protocol;
    }

    set protocol(value: Value) {
      const c = connection(this);
      if (c.state === "open" || c.state === "closing" || c.state === "closed") {
        throw s.rt.error("ArgumentError", 2014);
      }

      c.protocol = value === null || value === undefined ? null : s.rt.toString(value);
    }

    get closeReason(): number {
      return connection(this).closeReason;
    }

    startServer(socket: Value): void {
      if (socket === null || socket === undefined) {
        throw s.rt.error("TypeError", 2007, "socket");
      }

      // What AIR throws for a method its profile lacks (Updater.update in adl).
      throw s.rt.construct(
        s.rt.classNamed("flash.errors::IllegalOperationError"),
        "This method is not supported in this profile.",
      );
    }
  }

  avm2.registerNativeClass(natives, "air.net::WebSocket", WebSocketNatives);
  return natives;
}
