// One page's flash.net.Socket connections, made with node:net, or through
// the proxy (--proxy, proxy.ts): what the socket bridge (sockets.ts) holds
// for each page, apart from Electron so that node runs it in the tests
// (tests/desktop/connections.test.ts).
import { connect, type OnReadOpts, type Socket } from "node:net";
import type { SocketEvent } from "../shared/api.js";
import { type ProxyConfig, type ProxyError, tunnelThrough } from "./proxy.ts";

/** As many as a page may hold open at once; past it a connection is refused. */
const MAX_OPEN = 64;

/**
 * The bytes a connection may hold unsent, so that a peer that stops reading
 * cannot have the main process buffer all a SWF writes. Past it the
 * connection fails, as Flash's did when a write could not go.
 */
export const MAX_BUFFERED = 4 * 1024 * 1024;

/**
 * Each connection's read buffer, read into again and again, so that a read
 * makes one store, its copy for the page, where Node's stream would make a
 * Buffer for it besides.
 */
const READ_BUFFER = 64 * 1024;

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

export interface ConnectionOptions {
  /** What every connection goes through; none by default. */
  proxy?: ProxyConfig | null;
  /** Told why a connection through the proxy did not come about, for stderr. */
  warn?: (message: string) => void;
}

export class Connections {
  private readonly sockets = new Map<number, Socket>();
  /** Connections still being made through the proxy, each stopped by its controller. */
  private readonly opening = new Map<number, AbortController>();
  private readonly tell: (id: number, event: SocketEvent) => void;
  private readonly proxy: ProxyConfig | null;
  private readonly warn: (message: string) => void;

  /** `tell` carries each connection's events to its page. */
  constructor(tell: (id: number, event: SocketEvent) => void, options: ConnectionOptions = {}) {
    this.tell = tell;
    this.proxy = options.proxy ?? null;
    this.warn = options.warn ?? (() => {});
  }

  get size(): number {
    return this.sockets.size + this.opening.size;
  }

  /** Counts closeAll's: a connection decided on before one belongs to a page that is gone. */
  generation = 0;

  /**
   * Connect `id` to `host`:`port`, each checked, at `address` where the host was pinned (a remote
   * SWF's socket policy came from there); a refusal is an error, then a close. TCP_NODELAY unless
   * a SWF's tcpNoDelay sets `noDelay` false: Nagle's algorithm would hold a chatty protocol's
   * writes for the peer's delayed acknowledgements (docs/architecture/desktop.md, "Sockets").
   */
  connect(id: number, host: unknown, port: unknown, address?: string, noDelay = true): void {
    if (
      !validEndpoint(host, port) ||
      this.sockets.has(id) ||
      this.opening.has(id) ||
      this.size >= MAX_OPEN
    ) {
      this.refuse(id);
      return;
    }

    const target = address ?? host;
    if (this.proxy) {
      this.connectThrough(this.proxy, id, target, port as number, noDelay);
      return;
    }

    const socket = connect({
      host: target,
      port: port as number,
      noDelay,
      onread: this.reader(id),
    });
    socket.on("connect", () =>
      this.tell(id, {
        type: "open",
        localAddress: socket.localAddress ?? "",
        localPort: socket.localPort ?? 0,
        remoteAddress: socket.remoteAddress ?? "",
        remotePort: socket.remotePort ?? 0,
      }),
    );
    this.attach(id, socket);
  }

  /**
   * Connect `id` through `proxy`, by the pinned address, else by name for the
   * proxy to resolve; its peer is the target, the proxy no business of the
   * SWF's. Nagle's algorithm stays on through the handshake, which never
   * writes twice without an answer between, and goes off before the SWF's
   * first byte.
   */
  private connectThrough(
    proxy: ProxyConfig,
    id: number,
    target: string,
    port: number,
    noDelay: boolean,
  ): void {
    const opening = new AbortController();
    this.opening.set(id, opening);
    tunnelThrough(proxy, target, port, { signal: opening.signal, onread: this.reader(id) }).then(
      ({ socket, rest }) => {
        if (this.opening.get(id) !== opening) {
          socket.destroy();
          return;
        }

        this.opening.delete(id);
        socket.setNoDelay(noDelay);
        this.attach(id, socket);
        this.tell(id, {
          type: "open",
          localAddress: socket.localAddress ?? "",
          localPort: socket.localPort ?? 0,
          remoteAddress: target,
          remotePort: port,
        });
        // What came with the proxy's reply is the connection's first.
        if (rest.length > 0) {
          this.tell(id, { type: "data", bytes: rest });
        }

        socket.resume();
      },
      (error: ProxyError) => {
        if (this.opening.get(id) !== opening) {
          return;
        }

        this.opening.delete(id);
        this.warn(`no socket to ${target}:${port}: ${error.message}`);
        this.refuse(id);
      },
    );
  }

  /**
   * How `id`'s socket is read: into a buffer of its own, each read copied
   * out at its length for the page. It never pauses the socket, as its
   * stream never did.
   */
  private reader(id: number): OnReadOpts {
    return {
      buffer: new Uint8Array(READ_BUFFER),
      callback: (length, buffer) => {
        this.tell(id, { type: "data", bytes: new Uint8Array(buffer.subarray(0, length)) });
        return true;
      },
    };
  }

  private attach(id: number, socket: Socket): void {
    this.sockets.set(id, socket);
    socket.on("error", () => this.tell(id, { type: "error", message: SOCKET_ERROR }));
    socket.on("close", () => {
      // Only the socket under this id: a page that reused it has another by now.
      if (this.sockets.get(id) === socket) {
        this.sockets.delete(id);
      }

      this.tell(id, { type: "close" });
    });
  }

  /**
   * Write `bytes`, unless the peer has left more than MAX_BUFFERED unread: then the connection
   * fails.
   */
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
    const opening = this.opening.get(id);
    if (opening) {
      // Closed before the proxy made it: closed, as a socket destroyed before it connects.
      this.opening.delete(id);
      opening.abort();
      this.tell(id, { type: "close" });
      return;
    }

    this.sockets.get(id)?.destroy();
  }

  /**
   * Close every connection without a word: the page that held them is gone, and the next numbers
   * its own from 1.
   */
  closeAll(): void {
    for (const socket of this.sockets.values()) {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
    }

    for (const opening of this.opening.values()) {
      opening.abort();
    }

    this.sockets.clear();
    this.opening.clear();
    this.generation++;
  }
}
