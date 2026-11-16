// The connections network.ts's requests keep open between them: an idle
// keep-alive connection is handed to the next request that would open
// exactly the same one, as a browser's pool hands it, and to no other.
//
// A connection is kept under its key: the scheme, the host's name (TLS's
// server name and the certificate it is checked against), the address the
// request pinned that name to, the port, the route (direct, or the proxy
// by its kind, host and port, never its credentials) and, for https,
// whether the host's certificate goes unchecked (--ignore-certificate-
// errors); the authorities are the pool's, one set a network. So a request
// pinned to another address, as a name that rebinds gives it, never gets a
// connection to the old one; a host checked never shares a connection
// made unchecked; and a tunnel, which is to one target, serves only that
// target.
//
// Each connection is an undici Client, HTTP/1.1 only, which connects
// through the pool: to the pinned address whatever the resolver says now,
// directly or through a tunnel to it, TLS over either by the host's name.
// Undici sends a request and reads its answer, keeps the connection only
// once its response has been read to the end and the server meant to keep
// it, drops one the server closes or that errors while idle, and closes
// one idle past its time, sooner where the server's Keep-Alive says so.
//
// The pool keys them, at most six a key as browsers keep to a host, those
// still being made counted, and gives a request its connection itself: an
// idle one first, the one used last, and only where there is none a new
// one. Undici's own Agent would not do, as it keys its pools by origin
// alone and would hand a name pinned elsewhere the connection kept to the
// address before; nor would its proxy agents, which ask the proxy for the
// name; nor its Pool, which hands a request to the first client free,
// connected or not, so that one whose connection closed opens another
// while an idle one waits, and whose queue a request leaves only once it
// has a connection, closing that connection as it goes. Here a request
// waits for its key's turn, which it gives up for nothing; one given up
// while its connection is still being made closes that alone. The pool
// also tells whether a request's connection served one before, bounds
// idle connections all told, and ends every connection it opened, idle,
// in use or still being made, as a page goes, reloads or the app quits.
//
// Without Electron, so that node tests it (tests/desktop/http-pool.test.ts).
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import type { ConnectionOptions } from "node:tls";
import { buildConnector, Client, type Dispatcher } from "undici";
import { Refused } from "./network-types.ts";
import { connectThrough, describeProxy, type ProxyConfig, type ProxyError } from "./proxy.ts";

/** Where a request connects, as the pool keys it. */
export interface PoolTarget {
  secure: boolean;
  /** The host's name as the URL has it, bare: TLS's server name. */
  host: string;
  /** The address the request pinned the name to. */
  address: string;
  port: number;
  /** Whether the host's certificate goes unchecked; https only. */
  unverified: boolean;
}

export interface PoolLimits {
  /** Connections to one key at once, idle, in use or being made; more requests wait for one. */
  perKey: number;
  /** How long an idle connection is kept, in milliseconds. */
  idle: number;
  /** Idle connections kept all told, past which a connection freed is closed. */
  idleTotal: number;
}

const POOL_LIMITS: PoolLimits = { perKey: 6, idle: 4_000, idleTotal: 64 };

/** One try at a request on its key's connections. */
export interface Attempt {
  /** Whether its connection served a request before it: known once it is sent. */
  readonly reused: boolean;
  /**
   * It stopped: its connection closed, so that none comes back with half a
   * response on it, or, before it went, the connection being made for it.
   */
  cancel(reason: Error): void;
}

/** A request's turn on its key: at most `perKey` requests have one at once. */
export interface Turn {
  /** A try at the request, whose handler hears what undici says of it. */
  send(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): Attempt;
  /** The turn given back, the request done with its connection: the next waiting has it. */
  release(): void;
}

/** One connection of a key, and what the pool knows of it. */
class KeyClient extends Client {
  socket: Duplex | null = null;
  /** Gives up the connection being made; null when none is. */
  cancelConnect: ((reason: Error) => void) | null = null;
  /** When it was last given a request: of the idle ones, the one used last goes first. */
  used = 0;
}

interface Key {
  name: string;
  target: PoolTarget;
  /** The Host header's and TLS's: the name, never the address. */
  origin: string;
  clients: KeyClient[];
  /** TLS by the host's name, its sessions resumed within the key alone. */
  connector: (connection: buildConnector.Options, done: buildConnector.Callback) => Duplex;
  /** Requests with a turn. */
  active: number;
  waiting: ((turn: Turn) => void)[];
  /** Connections being made. */
  connecting: number;
}

function idleClient(client: KeyClient): boolean {
  const stats = client.stats;
  return !!stats.connected && stats.size === 0;
}

export class ConnectionPool {
  private readonly keys = new Map<string, Key>();
  /** Connections that served a request: the next to go on one is told it is reused. */
  private readonly served = new WeakSet<Duplex>();
  /** Every connection open or being made, whichever client holds it: what destroy() closes. */
  private readonly open = new Set<Duplex>();
  private readonly ca: string | string[] | undefined;
  private readonly proxy: ProxyConfig | null;
  private readonly limits: PoolLimits;
  /** Aborted by destroy(): tunnels still being made are given up. */
  private closing = new AbortController();
  private uses = 0;
  /** Connections opened since the pool was made, for tests and benchmarks. */
  opened = 0;

  constructor(
    options: {
      ca?: string | string[];
      proxy?: ProxyConfig | null;
      limits?: Partial<PoolLimits>;
    } = {},
  ) {
    this.ca = options.ca;
    this.proxy = options.proxy ?? null;
    this.limits = { ...POOL_LIMITS, ...options.limits };
  }

  /** The way a request reaches the address, as the key names it: never a proxy's credentials. */
  get route(): string {
    return this.proxy ? describeProxy(this.proxy) : "direct";
  }

  /** The key `target`'s connections are kept under. */
  keyOf(target: PoolTarget): string {
    return [
      target.secure ? "https" : "http",
      target.host,
      target.address,
      target.port,
      this.route,
      target.secure ? (target.unverified ? "unverified" : "verified") : "",
    ].join(" ");
  }

  /**
   * Hands `go` the request's turn on `target`'s key, at once where the key
   * has room, else once a request before it gives its turn back; the
   * function returned gives up waiting.
   */
  turn(target: PoolTarget, go: (turn: Turn) => void): () => void {
    const key = this.key(target);
    if (key.active < this.limits.perKey) {
      key.active++;
      go(this.given(key));
      return () => {};
    }

    key.waiting.push(go);
    return () => {
      const at = key.waiting.indexOf(go);
      if (at >= 0) {
        key.waiting.splice(at, 1);
      }
    };
  }

  /** Idle connections, all keys told. */
  idle(): number {
    let count = 0;
    for (const key of this.keys.values()) {
      for (const client of key.clients) {
        count += idleClient(client) ? 1 : 0;
      }
    }

    return count;
  }

  /** Every connection closed, idle or in use, and every one being made given up. */
  destroy(): void {
    this.closing.abort();
    this.closing = new AbortController();
    for (const key of this.keys.values()) {
      key.waiting.length = 0;
      for (const client of key.clients) {
        client.destroy().catch(() => {});
      }
    }

    // And any a client no longer holds, should one have slipped past it.
    for (const socket of this.open) {
      socket.destroy();
    }

    this.keys.clear();
    this.open.clear();
  }

  private key(target: PoolTarget): Key {
    const name = this.keyOf(target);
    let key = this.keys.get(name);
    if (!key) {
      const tls: ConnectionOptions = target.secure
        ? {
            ...(this.ca ? { ca: this.ca } : {}),
            ...(isIP(target.host) ? {} : { servername: target.host }),
            // Only where the user asked for this host: its certificate goes unchecked.
            ...(target.unverified ? { rejectUnauthorized: false } : {}),
          }
        : {};
      const host = target.host.includes(":") ? `[${target.host}]` : target.host;
      key = {
        name,
        target,
        origin: `${target.secure ? "https" : "http"}://${host}:${target.port}`,
        clients: [],
        // No timeout of undici's: the request's own timers (network.ts) count as it connects.
        connector: buildConnector({
          ...tls,
          allowH2: false,
          timeout: 0,
        }) as unknown as Key["connector"],
        active: 0,
        waiting: [],
        connecting: 0,
      };
      this.keys.set(name, key);
    }

    return key;
  }

  /** The connection a request goes on: the idle one used last, else one not yet made. */
  private choose(key: Key): KeyClient {
    let idle: KeyClient | null = null;
    let closed: KeyClient | null = null;
    for (const client of key.clients) {
      const stats = client.stats;
      if (stats.size > 0) {
        continue;
      }

      if (stats.connected) {
        if (!idle || client.used > idle.used) {
          idle = client;
        }
      } else {
        closed ??= client;
      }
    }

    // A key's turns keep its clients with a request to fewer than six: one more is room.
    return idle ?? closed ?? this.client(key);
  }

  private client(key: Key): KeyClient {
    const limits = this.limits;
    const client: KeyClient = new KeyClient(key.origin, {
      pipelining: 1,
      // HTTP/2 would carry every request to a host over one connection, beyond the six a
      // browser keeps to one over HTTP/1.1, and no Flash Player spoke it.
      allowH2: false,
      keepAliveTimeout: limits.idle,
      keepAliveMaxTimeout: limits.idle,
      // A server's Keep-Alive timeout less a second, as Node's Agent takes it.
      keepAliveTimeoutThreshold: 1_000,
      // The request's own timers bound it, from its turn.
      headersTimeout: 0,
      bodyTimeout: 0,
      connect: (connection, done) => this.connect(key, client, connection, done),
    });
    key.clients.push(client);
    const bound = () =>
      queueMicrotask(() => {
        if (idleClient(client) && this.idle() > limits.idleTotal) {
          client.socket?.destroy();
        }
      });
    // Its connection gone with no request waiting on it: the client goes too.
    const gone = () =>
      setImmediate(() => {
        const stats = client.stats;
        if (stats.connected || stats.size > 0) {
          return;
        }

        const at = key.clients.indexOf(client);
        if (at >= 0) {
          key.clients.splice(at, 1);
          client.destroy().catch(() => {});
        }

        this.prune(key);
      });
    client.on("connect", bound);
    client.on("drain", bound);
    client.on("disconnect", gone);
    client.on("connectionError", gone);
    return client;
  }

  /** A connection for `client`: to the pinned address, through the proxy where there is one. */
  private connect(
    key: Key,
    client: KeyClient,
    connection: buildConnector.Options,
    done: buildConnector.Callback,
  ): void {
    const target = key.target;
    const closing = this.closing.signal;
    const track = (socket: Duplex) => {
      this.open.add(socket);
      socket.once("close", () => this.open.delete(socket));
    };
    const failed = done as (error: Error, socket: null) => void;
    let settled = false;
    const finish = (error: Error | null, socket?: Duplex | null) => {
      if (settled) {
        return;
      }

      settled = true;
      key.connecting--;
      client.cancelConnect = null;
      if (error || !socket) {
        failed(error ?? new Refused("no connection"), null);
        return;
      }

      // Made as the pool closed: no connection outlives it.
      if (closing.aborted) {
        socket.destroy();
        failed(new Refused("aborted"), null);
        return;
      }

      this.opened++;
      client.socket = socket;
      (done as (error: null, socket: Duplex) => void)(null, socket);
    };
    // Never the name: the address the request was judged against.
    const pinned = { ...connection, hostname: target.address };
    const dial = (tunnel?: Duplex) => {
      const socket = key.connector(
        tunnel ? { ...pinned, httpSocket: tunnel as buildConnector.Options["httpSocket"] } : pinned,
        finish as buildConnector.Callback,
      );
      track(socket);
      // With an error, so that undici hears that the connection failed.
      client.cancelConnect = (reason) => socket.destroy(reason);
    };
    key.connecting++;
    const proxy = this.proxy;
    if (!proxy) {
      dial();
      return;
    }

    const giveUp = new AbortController();
    client.cancelConnect = (reason) => giveUp.abort(reason);
    const signal = AbortSignal.any([closing, giveUp.signal]);
    // Through the proxy to the pinned address, TLS over the tunnel for https.
    connectThrough(proxy, target.address, target.port, { signal }).then(
      (tunnel) => {
        if (signal.aborted) {
          tunnel.destroy();
          finish(new Refused("aborted"));
          return;
        }

        track(tunnel);
        if (target.secure) {
          dial(tunnel);
        } else {
          finish(null, tunnel);
        }
      },
      (error: ProxyError) => finish(new Refused(error.message, { cause: error })),
    );
  }

  private given(key: Key): Turn {
    let released = false;
    return {
      send: (options, handler) => this.send(key, options, handler),
      release: () => {
        if (released) {
          return;
        }

        released = true;
        key.active--;
        const next = key.waiting.shift();
        if (next) {
          key.active++;
          next(this.given(key));
        } else {
          setImmediate(() => this.prune(key));
        }
      },
    };
  }

  private send(
    key: Key,
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): Attempt {
    const served = this.served;
    const client = this.choose(key);
    client.used = ++this.uses;
    let controller: Dispatcher.DispatchController | null = null;
    let cancelled: Error | null = null;
    const attempt = {
      reused: false,
      cancel(reason: Error) {
        if (controller) {
          // Undici leaves a request done whole as it is, and closes any other's connection.
          controller.abort(reason);
          return;
        }

        if (!cancelled) {
          cancelled = reason;
          client.cancelConnect?.(reason);
        }
      },
    };
    client.dispatch(options, {
      onRequestStart(started, context) {
        controller = started;
        // Given up as its connection made ready for it: undici takes that down with it.
        if (cancelled) {
          started.abort(cancelled);
          return;
        }

        const socket = client.socket;
        if (socket) {
          attempt.reused = served.has(socket);
          served.add(socket);
        }

        handler.onRequestStart?.(started, context);
      },
      onResponseStart(c, status, headers, message) {
        handler.onResponseStart?.(c, status, headers, message);
      },
      onResponseData(c, chunk) {
        handler.onResponseData?.(c, chunk);
      },
      onResponseEnd(c, trailers) {
        // Undici counts the request on its connection until this returns: the end is told
        // after, so that the key's next request, a redirect's next hop among them, finds the
        // connection free rather than opening another.
        queueMicrotask(() => handler.onResponseEnd?.(c, trailers));
      },
      onResponseError(c, error) {
        handler.onResponseError?.(c, error);
      },
    });
    return attempt;
  }

  /** `key` forgotten once it has no connection, request nor connection being made left. */
  private prune(key: Key): void {
    if (
      this.keys.get(key.name) === key &&
      key.clients.length === 0 &&
      key.active === 0 &&
      key.waiting.length === 0 &&
      key.connecting === 0
    ) {
      this.keys.delete(key.name);
    }
  }
}
