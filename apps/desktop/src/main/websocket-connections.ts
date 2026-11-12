// One page's air.net.WebSocket connections, made with the WHATWG WebSocket
// of Electron's Node: what the WebSocket bridge (websockets.ts) holds for
// each page, apart from Electron so that node runs it in the tests
// (tests/desktop/websocket-connections.test.ts).
import type { WebSocketEvent } from "../shared/api.js";

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
 * application sends. Past this the connection fails.
 */
export const MAX_BUFFERED = 16 * 1024 * 1024;

const OPEN = 1;

/** What is used of the WHATWG WebSocket. */
interface Client {
  binaryType: string;
  readonly protocol: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number): void;
}

type ClientConstructor = new (
  url: string,
  // Node's takes its options in the protocols' place: undici's dispatcher among them.
  protocols: string[] | { protocols: string[]; dispatcher: unknown },
) => Client;

/** Opens a client; throws as the WebSocket constructor does. */
export type Opener = (url: string, protocols: string[]) => unknown;

const globalClient = (): ClientConstructor | undefined =>
  (globalThis as { WebSocket?: ClientConstructor }).WebSocket;

/** Whether this Node has the WHATWG WebSocket (22 and later, Electron's among them). */
export function hasWebSocket(): boolean {
  return typeof globalClient() === "function";
}

/**
 * What sends a client's requests with no certificate verified, for
 * --ignore-certificate-errors; null where this Node gives no way to make
 * one. The WHATWG WebSocket has no option for it: Node's is undici's,
 * which takes a dispatcher, and Node exports no class of one, so it is
 * made from the class of the dispatcher undici keeps for everything else.
 */
export function unverifiedDispatcher(): unknown {
  // Naming the global loads undici, which then sets its dispatcher.
  if (!hasWebSocket()) {
    return null;
  }

  const shared = (globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")];
  const Agent = (shared as { constructor?: unknown } | undefined)?.constructor;
  if (typeof Agent !== "function" || Agent.name !== "Agent") {
    return null;
  }

  try {
    const agent = new (Agent as new (options: object) => { dispatch?: unknown })({
      connect: { rejectUnauthorized: false },
    });
    return typeof agent.dispatch === "function" ? agent : null;
  } catch {
    return null;
  }
}

/**
 * An opener that leaves a wss: server's certificate unverified where
 * `unverified` says so of its host, through `dispatcher`
 * (unverifiedDispatcher's); any other connection is the global's as it is.
 */
export function webSocketOpener(
  unverified: (host: string) => boolean,
  dispatcher: unknown,
): Opener {
  return (url, protocols) => {
    const Client = globalClient() as ClientConstructor;
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    return dispatcher && parsed.protocol === "wss:" && unverified(host)
      ? new Client(url, { protocols, dispatcher })
      : new Client(url, protocols);
  };
}

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

/** The close codes the WHATWG WebSocket sends; any other throws. */
const sendable = (code: unknown): code is number =>
  code === 1000 || (typeof code === "number" && code >= 3000 && code <= 4999);

export class WebSocketConnections {
  private readonly clients = new Map<number, Client>();
  private readonly tell: (id: number, event: WebSocketEvent) => void;
  private readonly open: Opener;

  /** `tell` carries each connection's events to its page; `open` makes a client, the global's by default. */
  constructor(
    tell: (id: number, event: WebSocketEvent) => void,
    open: Opener = (url, protocols) => new (globalClient() as ClientConstructor)(url, protocols),
  ) {
    this.tell = tell;
    this.open = open;
  }

  get size(): number {
    return this.clients.size;
  }

  /** Counts closeAll's: a connection decided on before one belongs to a page that is gone. */
  generation = 0;

  /**
   * Connect `id` to `url`, offering `protocols`, each checked, as the page
   * asks; a refusal, a URL or protocols the client throws for among them,
   * is an error, then a close.
   */
  connect(id: number, url: unknown, protocols: unknown): void {
    if (
      !validWebSocketUrl(url) ||
      !validProtocols(protocols) ||
      this.clients.has(id) ||
      this.clients.size >= MAX_OPEN ||
      !hasWebSocket()
    ) {
      this.refuse(id);
      return;
    }

    let client: Client;
    try {
      client = this.open(url, protocols) as Client;
    } catch {
      this.refuse(id);
      return;
    }

    client.binaryType = "arraybuffer";
    this.clients.set(id, client);
    client.onopen = () => this.tell(id, { type: "open", protocol: client.protocol });
    client.onmessage = ({ data }) =>
      this.tell(id, {
        type: "message",
        data: typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer),
      });
    client.onerror = () => this.tell(id, { type: "error" });
    client.onclose = ({ code }) => {
      // Only the client under this id: a page that reused it has another by now.
      if (this.clients.get(id) === client) {
        this.clients.delete(id);
      }

      this.tell(id, { type: "close", code });
    };
  }

  /**
   * Send a text message for a string, a binary one for bytes, once the
   * connection is open, unless the peer has left more than MAX_BUFFERED
   * unread: then the connection fails.
   */
  send(id: number, data: string | Uint8Array): void {
    const client = this.clients.get(id);
    if (!client || client.readyState !== OPEN) {
      return;
    }

    const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    if (client.bufferedAmount + size > MAX_BUFFERED) {
      // The client has no way to drop a connection: its close waits behind
      // what is buffered, so the page is told now and the client left to it.
      this.silence(client);
      this.clients.delete(id);
      this.tell(id, { type: "error" });
      this.tell(id, { type: "close", code: 1006 });
      return;
    }

    client.send(data);
  }

  /** Refuse `id`, as a server that took no connection: an error, then a close with no frame. */
  refuse(id: number): void {
    this.tell(id, { type: "error" });
    this.tell(id, { type: "close", code: 1006 });
  }

  /** A close frame with `code` where the client sends it, 1000 or 3000 to 4999, else with none. */
  close(id: number, code?: unknown): void {
    const client = this.clients.get(id);
    if (!client) {
      return;
    }

    try {
      client.close(sendable(code) ? code : undefined);
    } catch {
      // Already closing.
    }
  }

  /**
   * Close every connection without a word: the page that held them is
   * gone, and the next numbers its own from 1.
   */
  closeAll(): void {
    for (const client of this.clients.values()) {
      this.silence(client);
    }

    this.clients.clear();
    this.generation++;
  }

  private silence(client: Client): void {
    client.onopen = null;
    client.onmessage = null;
    client.onerror = null;
    client.onclose = null;
    try {
      client.close();
    } catch {
      // Already closing.
    }
  }
}
