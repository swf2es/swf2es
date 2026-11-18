// Shared Socket and SecureSocket buffers, event ordering and connection generations.
import { avm2 } from "@swf2es/runtime";
import type {
  SocketEndpoints,
  SocketEvents,
  SocketOptions,
  SocketTransport,
} from "../../../hosts.js";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;

export type SocketConnector = (
  events: SocketEvents,
  options: SocketOptions | undefined,
  current: () => boolean,
) => SocketTransport;

export interface Connection {
  input: AsObject;
  output: AsObject;
  transport: SocketTransport | null;
  generation: number;
  connected: boolean;
  connecting: boolean;
  failed: boolean;
  /** Null before a connection and after close(); UNKNOWN while one opens, or open where the host does not know them. */
  endpoints: SocketEndpoints | null;
  /** AIR's tcpNoDelay as the script set it; null until it does, for the host's default. */
  noDelay: boolean | null;
  closed?: () => void;
}

const UNKNOWN: SocketEndpoints = {
  localAddress: "",
  localPort: 0,
  remoteAddress: "",
  remotePort: 0,
};

export class SocketConnections {
  private readonly s: Scripting;
  private readonly connections = new WeakMap<AsObject, Connection>();

  constructor(s: Scripting) {
    this.s = s;
  }

  get(o: AsObject): Connection {
    const s = this.s;
    let c = this.connections.get(o);
    if (!c) {
      c = {
        input: s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")),
        output: s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")),
        transport: null,
        generation: 0,
        connected: false,
        connecting: false,
        failed: false,
        endpoints: null,
        noDelay: null,
      };
      this.connections.set(o, c);
    }

    return c;
  }

  connect(object: AsObject, create: SocketConnector | undefined, errorID = 0): void {
    const s = this.s;

    const c = this.get(object);
    c.generation++;
    c.transport?.close();
    c.transport = null;
    c.connected = false;
    c.connecting = true;
    c.failed = false;
    c.endpoints = UNKNOWN;
    avm2.bytesOf(s.rt, c.input).clear();
    avm2.bytesOf(s.rt, c.output).clear();
    const generation = c.generation;
    const current = () => c.generation === generation;
    const fail = (message: string) => {
      if (!current()) {
        return;
      }

      c.generation++;
      c.connecting = false;
      c.connected = false;
      c.transport?.close();
      c.transport = null;
      c.failed = true;
      dispatchEvent(
        s,
        object,
        s.rt.construct(
          s.rt.classNamed("flash.events::IOErrorEvent"),
          "ioError",
          false,
          false,
          message,
          errorID,
        ),
      );
    };
    if (!create) {
      s.loads.deferHostEvent(() => fail("Error #2031: Socket Error."));
      return;
    }

    try {
      c.transport = create(
        {
          open: (endpoints) =>
            s.loads.deferHostEvent(() => {
              if (!current()) {
                return;
              }

              c.connecting = false;
              c.connected = true;
              c.endpoints = endpoints ? { ...endpoints } : UNKNOWN;
              dispatchEvent(s, object, s.event("connect"));
            }),
          data: (bytes, owned) => {
            // Delivered on a later turn: a host's reused buffer would have changed by then.
            const copy = owned ? bytes : new Uint8Array(bytes);
            s.loads.deferHostEvent(() => {
              if (!current() || !c.connected) {
                return;
              }

              const buffer = avm2.bytesOf(s.rt, c.input);
              if (buffer.position >= 65536 && buffer.position * 2 >= buffer.length) {
                const unread = buffer.available;
                buffer.buffer.copyWithin(0, buffer.position, buffer.length);
                buffer.setLength(unread);
                buffer.position = 0;
              }

              const position = buffer.position;
              buffer.position = buffer.length;
              buffer.write(copy);
              buffer.position = position;
              dispatchEvent(
                s,
                object,
                s.rt.construct(
                  s.rt.classNamed("flash.events::ProgressEvent"),
                  "socketData",
                  false,
                  false,
                  copy.length,
                  0,
                ),
              );
            });
          },
          close: () =>
            s.loads.deferHostEvent(() => {
              if (!current()) {
                return;
              }

              if (c.connecting) {
                fail("Error #2031: Socket Error.");
                return;
              }

              c.generation++;
              c.connected = false;
              c.connecting = false;
              c.transport = null;
              c.closed?.();
              dispatchEvent(s, object, s.event("close"));
            }),
          error: (message) => s.loads.deferHostEvent(() => fail(message)),
        },
        c.noDelay === null ? undefined : { noDelay: c.noDelay },
        current,
      );
    } catch (e) {
      s.loads.deferHostEvent(() => fail(String(e)));
    }
  }
}
