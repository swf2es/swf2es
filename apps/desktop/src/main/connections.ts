// One page's flash.net.Socket connections, made with node:net: what the
// socket bridge (sockets.ts) holds for each page, apart from Electron so
// that node runs it in the tests (tests/desktop/connections.test.ts).
import { connect, type Socket } from "node:net";
import type { SocketEvent } from "../shared/api.js";

/** As many as a page may hold open at once; past it a connection is refused. */
export const MAX_OPEN = 64;

/**
 * The bytes a connection may hold unsent. A peer that stops reading would
 * otherwise have the main process buffer all a SWF writes: 100 writes of
 * 8 MB took it from 238 to 1038 MB. Past this the connection fails, as
 * Flash's did when a write could not go.
 */
export const MAX_BUFFERED = 4 * 1024 * 1024;

const SOCKET_ERROR = "Error #2031: Socket Error.";

/** Whether the page asked for a host name of DNS's length and a TCP port. */
export function validEndpoint(host: unknown, port: unknown): host is string {
  return (
    typeof host === "string" &&
    host.length > 0 &&
    host.length <= 255 &&
    typeof port === "number" &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536
  );
}

export class Connections {
  private readonly sockets = new Map<number, Socket>();
  private readonly tell: (id: number, event: SocketEvent) => void;

  /** `tell` carries each connection's events to its page. */
  constructor(tell: (id: number, event: SocketEvent) => void) {
    this.tell = tell;
  }

  get size(): number {
    return this.sockets.size;
  }

  /** Counts closeAll's: a connection decided on before one belongs to a page that is gone. */
  generation = 0;

  /** Connect `id` to `host`:`port`, each checked, as the page asks; a refusal is an error, then a close. */
  connect(id: number, host: unknown, port: unknown): void {
    if (!validEndpoint(host, port) || this.sockets.has(id) || this.sockets.size >= MAX_OPEN) {
      this.refuse(id);
      return;
    }

    const socket = connect({ host, port: port as number });
    this.sockets.set(id, socket);
    socket.on("connect", () =>
      this.tell(id, {
        type: "open",
        localAddress: socket.localAddress ?? "",
        localPort: socket.localPort ?? 0,
        remoteAddress: socket.remoteAddress ?? "",
        remotePort: socket.remotePort ?? 0,
      }),
    );
    socket.on("data", (bytes) => this.tell(id, { type: "data", bytes: new Uint8Array(bytes) }));
    socket.on("error", () => this.tell(id, { type: "error", message: SOCKET_ERROR }));
    socket.on("close", () => {
      // Only the socket under this id: a page that reused it has another by now.
      if (this.sockets.get(id) === socket) {
        this.sockets.delete(id);
      }

      this.tell(id, { type: "close" });
    });
  }

  /** Write `bytes`, unless the peer has left more than MAX_BUFFERED unread: then the connection fails. */
  send(id: number, bytes: Uint8Array): void {
    const socket = this.sockets.get(id);
    if (!socket || socket.destroyed) {
      return;
    }

    if (socket.writableLength + bytes.length > MAX_BUFFERED) {
      this.tell(id, { type: "error", message: SOCKET_ERROR });
      socket.destroy();
      return;
    }

    socket.write(bytes);
  }

  /** Refuse `id`, as a server that took no connection: an error, then a close. */
  refuse(id: number): void {
    this.tell(id, { type: "error", message: SOCKET_ERROR });
    this.tell(id, { type: "close" });
  }

  close(id: number): void {
    this.sockets.get(id)?.destroy();
  }

  /** Close every connection without a word: the page that held them is gone, and the next numbers its own from 1. */
  closeAll(): void {
    for (const socket of this.sockets.values()) {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
    }

    this.sockets.clear();
    this.generation++;
  }
}
