// One page's air.net.WebSocket connections, made with ws over connections
// of our own: what the WebSocket bridge (websockets.ts) holds for each
// page, apart from Electron so that node runs it in the tests
// (tests/desktop/websocket-connections.test.ts). Each resolves its host
// once and connects to that address, or goes through the proxy by name;
// TLS checks the certificate against the host's name. Frames go as AIR
// sends them and come as adl keeps them (docs/architecture/services.md,
// "AIR's WebSocket").
import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import * as tls from "node:tls";
import WebSocket from "ws";
import type { WebSocketEvent } from "../shared/api.js";
import { type AddressClass, addressClass } from "./addresses.ts";
import { abortable, bare, defaultCa } from "./network-rules.ts";
import { connectThrough, type ProxyConfig, ProxyError } from "./proxy.ts";

/** As many as a page may hold open at once; past it a connection is refused. */
const MAX_OPEN = 64;

/** The longest URL, and the most and longest subprotocols, a page may ask for. */
const MAX_URL = 8192;
const MAX_PROTOCOLS = 32;
const MAX_PROTOCOL = 256;

/**
 * The bytes a connection may hold unsent, as a socket's (connections.ts)
 * but for whole messages, which are larger than a socket's writes: a peer
 * that stops reading would otherwise have the main process buffer all an
 * application sends, or all the pongs its pings ask for. Past this the
 * connection fails.
 */
export const MAX_BUFFERED = 16 * 1024 * 1024;

/**
 * How long a connection may take to be made, its lookup, tunnel and TLS
 * included, until ws takes it; then its handshake; and how long the page
 * may take to answer about a self-signed certificate.
 */
const TIMEOUT = 30_000;

/**
 * The largest message a connection takes; a larger one fails it (ws closes
 * with 1009). adl took messages of 20 MB, so this leaves room above them,
 * while bounding what one connection holds as a message comes.
 */
const MAX_PAYLOAD = 32 * 1024 * 1024;

const TEXT = 1;
const BINARY = 2;
const CLOSE = 8;
const PING = 9;
const PONG = 10;

/** The opcodes a page may send: AIR's fmt constants. */
const OPCODES = new Set([TEXT, BINARY, CLOSE, PING, PONG]);

export const validOpcode = (opcode: unknown): opcode is number => OPCODES.has(opcode as number);

/** The close codes RFC 6455 lets a frame carry, which ws sends; another closes with none. */
const sendable = (code: number) =>
  (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
  (code >= 3000 && code <= 4999);

/** Whether the page asked for a ws: or wss: URL with a host, of a length a server takes. */
export function validWebSocketUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > MAX_URL) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (parsed.protocol === "ws:" || parsed.protocol === "wss:") && parsed.hostname !== "";
  } catch {
    return false;
  }
}

export function validProtocols(protocols: unknown): protocols is string[] {
  return (
    Array.isArray(protocols) &&
    protocols.length <= MAX_PROTOCOLS &&
    protocols.every((p) => typeof p === "string" && p.length <= MAX_PROTOCOL)
  );
}

export interface WebSocketOptions {
  /** What every connection goes through, by the host's name; none by default. */
  proxy?: ProxyConfig | null;
  /** Whether --ignore-certificate-errors names `host`: its certificate goes unchecked. */
  unverified?: (host: string) => boolean;
  /** A host's addresses, the system resolver's by default. */
  resolve?: (host: string) => Promise<string[]>;
  /** Where an address is (addresses.ts by default); null for one no connection reaches. */
  classify?: (address: string) => AddressClass | null;
  /** The certificates trusted: the system's beside Node's, as the network's, by default. */
  ca?: string | string[];
  /** Told why a connection was refused, or the proxy did not make it, for stderr. */
  warn?: (message: string) => void;
  /** TIMEOUT, and MAX_PAYLOAD, but where a test asks for less. */
  timeout?: number;
  maxPayload?: number;
}

/** What makes a connection: its lookup, tunnel, TLS and certificate's question. */
interface Opening {
  /** Stops it, as its connection goes. */
  controller: AbortController;
  /** Takes the page's answer about a self-signed certificate, while it is asked. */
  answer: ((accepted: boolean) => void) | null;
}

interface Connection {
  client: WebSocket;
  opening: Opening;
}

/** A connection this side refused, said on stderr, unlike a server that is not there. */
class Refusal extends Error {}

export class WebSocketConnections {
  private readonly connections = new Map<number, Connection>();
  private readonly tell: (id: number, event: WebSocketEvent) => void;
  private readonly proxy: ProxyConfig | null;
  private readonly unverified: (host: string) => boolean;
  private readonly resolve: (host: string) => Promise<string[]>;
  private readonly classify: (address: string) => AddressClass | null;
  private readonly ca: string | string[] | undefined;
  private readonly warn: (message: string) => void;
  private readonly timeout: number;
  private readonly maxPayload: number;

  /** `tell` carries each connection's events to its page. */
  constructor(tell: (id: number, event: WebSocketEvent) => void, options: WebSocketOptions = {}) {
    this.tell = tell;
    this.proxy = options.proxy ?? null;
    this.unverified = options.unverified ?? (() => false);
    this.resolve =
      options.resolve ??
      (async (host) =>
        (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address));
    this.classify = options.classify ?? addressClass;
    this.ca = options.ca ?? defaultCa();
    this.warn = options.warn ?? (() => {});
    this.timeout = options.timeout ?? TIMEOUT;
    this.maxPayload = options.maxPayload ?? MAX_PAYLOAD;
  }

  get size(): number {
    return this.connections.size;
  }

  /**
   * Connect `id` to `url`, offering `protocols`, each checked, as the page
   * asks; a refusal, a URL or protocols the client throws for among them,
   * is an error, then a close.
   */
  connect(id: number, url: unknown, protocols: unknown): void {
    if (
      !validWebSocketUrl(url) ||
      !validProtocols(protocols) ||
      this.connections.has(id) ||
      this.connections.size >= MAX_OPEN
    ) {
      this.refuse(id);
      return;
    }

    const target = new URL(url);
    // adl takes what comes before a URL's ":" for its host, and so connects nowhere with
    // credentials; ws would send them as Authorization: Basic. Refused, nothing sent.
    if (target.username !== "" || target.password !== "") {
      this.warn(`no WebSocket to ${target.host}: its URL carries credentials`);
      this.refuse(id);
      return;
    }

    const host = bare(target.hostname);
    const secure = target.protocol === "wss:";
    const port = Number(target.port) || (secure ? 443 : 80);
    const opening: Opening = { controller: new AbortController(), answer: null };

    /** The connection was made: a failure after it is the handshake's. */
    let reached = false;
    let opened = false;
    let chosen: string | undefined;
    let unoffered = false;

    let client: WebSocket;
    try {
      client = new WebSocket(url, {
        createConnection: (_options, done) => {
          this.reach(id, opening, host, port, secure).then(
            (socket) => {
              reached = true;
              done(null, socket);
            },
            (error: Error) => done(error),
          );
          return undefined;
        },
        // Offered as AIR offers them, joined by ", ", and not to ws, which would fail a server
        // that chose none of them, or one when none was offered, where AIR takes either.
        headers: protocols.length > 0 ? { "Sec-WebSocket-Protocol": protocols.join(", ") } : {},
        // AIR offers no extension, answers pings itself, and keeps a text message's bytes as
        // they came, whether they are UTF-8 or not.
        perMessageDeflate: false,
        // Answered by the "ping" listener, within MAX_BUFFERED: ws 8.22.1, pinned, answers
        // without bound, the ping flood 8.23.0 fixed. On 8.23.0 or later, after 2026-11-26,
        // when it is two weeks old, ws may answer them again.
        autoPong: false,
        skipUTF8Validation: true,
        maxPayload: this.maxPayload,
        handshakeTimeout: this.timeout,
      });
    } catch {
      opening.controller.abort();
      this.refuse(id);
      return;
    }

    const connection: Connection = { client, opening };
    this.connections.set(id, connection);
    client.on("upgrade", (response) => {
      const header = response.headers["sec-websocket-protocol"];
      delete response.headers["sec-websocket-protocol"];
      chosen = Array.isArray(header) ? header.join(", ") : header;
      // A subprotocol chosen that was not offered fails the handshake in adl, without a close.
      if (chosen !== undefined && protocols.length > 0 && !protocols.includes(chosen)) {
        unoffered = true;
        response.socket.destroy();
        client.terminate();
      }
    });
    client.on("open", () => {
      opened = true;
      this.tell(id, { type: "open", protocol: chosen ?? "" });
    });
    client.on("message", (data, isBinary) =>
      // A copy of its own: Electron's IPC sends a typed array's whole store.
      this.tell(id, { type: "message", data: new Uint8Array(data), text: !isBinary }),
    );
    client.on("ping", (data) => {
      // AIR answers a ping itself and dispatches nothing; not past what may wait unsent.
      if (client.bufferedAmount + data.length > MAX_BUFFERED) {
        this.overflow(id, connection);
        return;
      }

      client.pong(data);
    });
    client.on("error", () => {
      const failure = unoffered ? "subprotocol" : !opened && reached ? "handshake" : undefined;
      this.tell(id, failure ? { type: "error", failure } : { type: "error" });
    });
    client.on("close", (code) => {
      opening.controller.abort();
      // Only the connection under this id: a page that reused it has another by now.
      if (this.connections.get(id) === connection) {
        this.connections.delete(id);
      }

      this.tell(id, { type: "close", code });
    });
  }

  /**
   * A frame of `opcode` with `payload`, as AIR sends it, once the connection
   * is open, unless the peer has left more than MAX_BUFFERED unread: then
   * the connection fails. One sent while connecting ends the connection,
   * as AIR's handshake breaks on it.
   */
  frame(id: number, opcode: number, payload: Uint8Array): void {
    const connection = this.connections.get(id);
    if (!connection) {
      return;
    }

    const client = connection.client;
    if (client.readyState === WebSocket.CONNECTING) {
      client.terminate();
      return;
    }

    if (client.readyState !== WebSocket.OPEN) {
      return;
    }

    if (client.bufferedAmount + payload.length > MAX_BUFFERED) {
      this.overflow(id, connection);
      return;
    }

    try {
      switch (opcode) {
        case TEXT:
          client.send(payload, { binary: false });
          break;
        case BINARY:
          client.send(payload, { binary: true });
          break;
        case CLOSE: {
          // The payload's first two bytes are the code, the rest its reason, as AIR sends them.
          const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 0;
          const reason = payload.subarray(2);
          if (!sendable(code)) {
            client.close();
          } else if (reason.length > 123) {
            client.close(code);
          } else {
            client.close(code, reason);
          }

          break;
        }
        case PING:
          client.ping(payload);
          break;
        case PONG:
          client.pong(payload);
          break;
      }
    } catch {
      // A ping or pong past a control frame's 125 bytes, which ws refuses to send.
    }
  }

  /** The page's answer to "certificate": whether the connection goes on. */
  certificate(id: number, accepted: boolean): void {
    this.connections.get(id)?.opening.answer?.(accepted);
  }

  /** Refuse `id`, as a server that took no connection: an error, then a close with no frame. */
  refuse(id: number): void {
    this.tell(id, { type: "error" });
    this.tell(id, { type: "close", code: 1006 });
  }

  /**
   * Drop every connection without a word, as AIR's go as it exits: the
   * page that held them is gone, and the next numbers its own from 1.
   */
  closeAll(): void {
    for (const connection of this.connections.values()) {
      this.silence(connection);
    }

    this.connections.clear();
  }

  /**
   * The connection made for `id`: by the proxy, or to the address its host
   * resolves to now, within the timeout, which pauses while the page is
   * asked about a certificate.
   */
  private async reach(
    id: number,
    opening: Opening,
    host: string,
    port: number,
    secure: boolean,
  ): Promise<Duplex> {
    const signal = opening.controller.signal;
    const where = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      opening.controller.abort();
    }, this.timeout);
    try {
      let socket: Socket;
      try {
        socket = this.proxy
          ? await connectThrough(this.proxy, host, port, { signal })
          : await this.direct(host, port, signal);
      } catch (error) {
        if (!late && (error instanceof ProxyError || error instanceof Refusal)) {
          this.warn(`no WebSocket to ${where}: ${error.message}`);
        }

        throw error;
      }

      return secure
        ? await this.secure(id, opening, socket, host, () => clearTimeout(timer))
        : socket;
    } catch (error) {
      if (late) {
        this.warn(`no WebSocket to ${where}: it took too long`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A TCP connection to `host`'s address, resolved here once, so that DNS
   * that changes its answer reaches nothing this did not place; refused
   * for an address no connection reaches, as the network refuses one.
   */
  private async direct(host: string, port: number, signal: AbortSignal): Promise<Socket> {
    let address = host;
    if (!isIP(host)) {
      let addresses: string[] = [];
      try {
        addresses = await abortable(this.resolve(host), signal);
      } catch {
        // No address, said below.
      }

      if (signal.aborted) {
        throw new Error("aborted");
      }

      if (addresses.length === 0) {
        throw new Refusal(`${host} has no address`);
      }

      address = addresses[0];
    }

    if (this.classify(address) === null) {
      throw new Refusal(`${host} is at ${address}, which no connection reaches`);
    }

    return new Promise((resolve, reject) => {
      const socket = connect({ host: address, port });
      const fail = (error: Error) => {
        signal.removeEventListener("abort", abort);
        socket.destroy();
        reject(error);
      };
      const abort = () => fail(new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      socket.once("error", fail);
      socket.once("connect", () => {
        signal.removeEventListener("abort", abort);
        socket.removeListener("error", fail);
        resolve(socket);
      });
    });
  }

  /**
   * TLS over `socket`, its certificate checked against `host`, the URL's,
   * not the address it was reached at: unchecked where
   * --ignore-certificate-errors names the host; a self-signed one left to
   * the application, which AIR asks with a certificateError, `asking`
   * told first; any other fault fails the connection, as does a page that
   * does not answer within the timeout.
   */
  private secure(
    id: number,
    opening: Opening,
    socket: Socket,
    host: string,
    asking: () => void,
  ): Promise<Duplex> {
    const signal = opening.controller.signal;
    // Dropped as the TCP connection was made: no question goes to a page that may be another.
    if (signal.aborted) {
      socket.destroy();
      return Promise.reject(new Error("aborted"));
    }

    return new Promise((resolve, reject) => {
      const secure = tls.connect({
        socket,
        // The name the certificate must carry, and the one the server is told, unless an address.
        host,
        ...(isIP(host) ? {} : { servername: host }),
        ALPNProtocols: ["http/1.1"],
        ...(this.ca ? { ca: this.ca } : {}),
        // Checked below, so that a self-signed certificate can be the application's to accept.
        rejectUnauthorized: false,
      });
      let unanswered: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(unanswered);
        signal.removeEventListener("abort", abort);
        secure.removeListener("error", fail);
        resolve(secure);
      };
      const fail = (error: Error) => {
        clearTimeout(unanswered);
        opening.answer = null;
        signal.removeEventListener("abort", abort);
        secure.destroy();
        reject(error);
      };
      const abort = () => fail(new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      secure.once("error", fail);
      secure.once("secureConnect", () => {
        if (secure.authorized || this.unverified(host)) {
          done();
          return;
        }

        // Only a certificate that is self-signed and otherwise sound is asked about, as adl
        // asks: OpenSSL says CERT_HAS_EXPIRED for an expired one, which fails without a word.
        const why = String(secure.authorizationError);
        if (why !== "DEPTH_ZERO_SELF_SIGNED_CERT") {
          fail(new Error(`its certificate is refused: ${why}`));
          return;
        }

        opening.answer = (accepted) => {
          opening.answer = null;
          if (accepted) {
            done();
          } else {
            fail(new Error("its certificate is self-signed"));
          }
        };
        asking();
        unanswered = setTimeout(
          () =>
            fail(new Error("its certificate is self-signed, and the application did not answer")),
          this.timeout,
        );
        this.tell(id, { type: "certificate" });
      });
    });
  }

  /** Fail a connection whose peer has left too much unread: an error, then a close with no frame. */
  private overflow(id: number, connection: Connection): void {
    this.silence(connection);
    this.connections.delete(id);
    this.tell(id, { type: "error" });
    this.tell(id, { type: "close", code: 1006 });
  }

  /** Drop a connection, its events no one's: nothing is told of it after. */
  private silence(connection: Connection): void {
    connection.opening.controller.abort();
    const client = connection.client;
    client.removeAllListeners();
    // A handshake ended now still reports its error, to no one.
    client.on("error", () => {});
    client.terminate();
  }
}
