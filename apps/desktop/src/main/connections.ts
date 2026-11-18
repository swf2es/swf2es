// One page's Socket and SecureSocket connections, direct or through
// the proxy (--proxy, proxy.ts): what the socket bridge (sockets.ts) holds
// for each page, apart from Electron so that node runs it in the tests
// (tests/desktop/connections.test.ts).
import { connect, type OnReadOpts, Socket } from "node:net";
import type { SecureSocketEvents, SecureSocketOptions, SocketEndpoints } from "@swf2es/player";
import {
  type TlsTransport,
  tlsConnect,
  tlsSocket,
  validCertificate,
} from "@swf2es/player-hosts/node";
import type { SocketEvent } from "../shared/api.js";
import { connectThrough, type ProxyConfig, type ProxyError, tunnelThrough } from "./proxy.ts";

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

/** IPC input is untrusted even when it came from the application's page. */
export function secureOptions(value: unknown): SecureSocketOptions | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const options = value as Partial<SecureSocketOptions>;
  if (
    !Number.isInteger(options.timeout) ||
    (options.timeout ?? 0) < 1 ||
    (options.timeout ?? 0) > 0xffffffff ||
    !Array.isArray(options.certificates) ||
    options.certificates.length > 64
  ) {
    return null;
  }

  let total = 0;
  for (const certificate of options.certificates) {
    if (
      !certificate ||
      !(certificate.encoded instanceof Uint8Array) ||
      typeof certificate.trusted !== "boolean"
    ) {
      return null;
    }

    total += certificate.encoded.length;
    if (total > MAX_BUFFERED || !validCertificate(certificate.encoded)) {
      return null;
    }
  }

  return options as SecureSocketOptions;
}

export interface ConnectionOptions {
  /** What every connection goes through; none by default. */
  proxy?: ProxyConfig | null;
  /** Told why a connection through the proxy did not come about, for stderr. */
  warn?: (message: string) => void;
}

export class Connections {
  private readonly sockets = new Map<number, Socket>();
  private readonly secure = new Map<number, TlsTransport>();
  private readonly decisions = new Map<number, (accepted: boolean) => void>();
  /** Pending permission requests and proxy tunnels, each cancelled by its controller. */
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

  /** Reserve a pending permission request so close() and page end can cancel it. */
  reserve(id: number): (() => boolean) | null {
    if (this.sockets.has(id) || this.opening.has(id) || this.size >= MAX_OPEN) {
      this.refuse(id);
      return null;
    }

    const waiting = new AbortController();
    this.opening.set(id, waiting);
    return () => {
      if (this.opening.get(id) !== waiting) {
        return false;
      }

      this.opening.delete(id);
      return true;
    };
  }

  /**
   * Connect `id` to `host`:`port`, each checked, at `address` where the host was pinned (a remote
   * SWF's socket policy came from there); a refusal is an error, then a close. TCP_NODELAY unless
   * a SWF's tcpNoDelay sets `noDelay` false: Nagle's algorithm would hold a chatty protocol's
   * writes for the peer's delayed acknowledgements (docs/architecture/desktop.md, "Sockets").
   */
  connect(
    id: number,
    host: unknown,
    port: unknown,
    address?: string,
    noDelay = true,
    secure?: SecureSocketOptions,
  ): void {
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
      this.connectThrough(this.proxy, id, host, target, port as number, noDelay, secure);
      return;
    }

    if (secure) {
      this.attachSecure(
        id,
        {
          address: target,
          port: port as number,
        },
        host,
        { ...secure, noDelay },
      );
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
    host: string,
    target: string,
    port: number,
    noDelay: boolean,
    secure?: SecureSocketOptions,
  ): void {
    const opening = new AbortController();
    this.opening.set(id, opening);
    const started = Date.now();
    const tunnel = secure
      ? connectThrough(proxy, target, port, {
          signal: opening.signal,
          timeout: Math.min(secure.timeout, 0x7fffffff),
        }).then((socket) => ({ socket, rest: new Uint8Array() }))
      : tunnelThrough(proxy, target, port, { signal: opening.signal, onread: this.reader(id) });
    tunnel.then(
      ({ socket, rest }) => {
        if (this.opening.get(id) !== opening) {
          socket.destroy();
          return;
        }

        this.opening.delete(id);
        socket.setNoDelay(noDelay);
        if (secure) {
          this.attachSecure(
            id,
            socket,
            host,
            { ...secure, timeout: Math.max(1, secure.timeout - (Date.now() - started)) },
            { remoteAddress: target, remotePort: port },
          );
          return;
        }
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

  private attachSecure(
    id: number,
    target: Socket | { address: string; port: number },
    host: string,
    options: SecureSocketOptions,
    remote?: Pick<SocketEndpoints, "remoteAddress" | "remotePort">,
  ): void {
    let transport: TlsTransport;
    const generation = this.generation;
    const current = () => this.generation === generation && this.secure.get(id) === transport;
    try {
      const events = {
        open: (endpoints) => {
          if (current() && endpoints) {
            this.sockets.set(id, transport.socket);
            this.tell(id, { type: "open", ...endpoints });
          }
        },
        data: (bytes) => {
          if (current()) {
            this.tell(id, { type: "data", bytes });
          }
        },
        certificate: (status, certificate) => {
          if (current()) {
            this.tell(id, { type: "certificate", status, certificate });
          }
        },
        certificateError: (proceed) => {
          if (!current()) {
            proceed(false);
            return;
          }

          this.decisions.set(id, proceed);
          this.tell(id, { type: "certificateError" });
        },
        error: (message) => {
          if (current()) {
            this.tell(id, { type: "error", message });
          }
        },
        close: () => {
          if (current()) {
            this.secure.delete(id);
            this.sockets.delete(id);
            this.decisions.delete(id);
            this.tell(id, { type: "close" });
          }
        },
      } satisfies SecureSocketEvents;
      transport =
        target instanceof Socket
          ? tlsSocket(target, host, events, options, remote)
          : tlsConnect(host, target.port, events, options, target.address);
      this.secure.set(id, transport);
      this.sockets.set(id, transport.socket);
    } catch {
      if (target instanceof Socket) {
        target.destroy();
      }

      this.refuse(id);
    }
  }

  certificate(id: number, accepted: boolean): void {
    const proceed = this.decisions.get(id);
    this.decisions.delete(id);
    proceed?.(accepted);
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

    const secure = this.secure.get(id);
    if (secure) {
      secure.send(bytes);
    } else {
      socket.write(bytes);
    }
  }

  /** Refuse `id`, as a server that took no connection: an error, then a close. */
  refuse(id: number): void {
    this.tell(id, { type: "error", message: SOCKET_ERROR });
    this.tell(id, { type: "close" });
  }

  close(id: number): void {
    const secure = this.secure.get(id);
    if (secure) {
      this.decisions.delete(id);
      secure.close();
      return;
    }

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
    for (const secure of this.secure.values()) {
      secure.close();
    }

    for (const socket of this.sockets.values()) {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
    }

    for (const opening of this.opening.values()) {
      opening.abort();
    }

    this.sockets.clear();
    this.secure.clear();
    this.decisions.clear();
    this.opening.clear();
    this.generation++;
  }
}
