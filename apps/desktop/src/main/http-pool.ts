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
// Each key is a Node Agent of its own (keepAlive, at most six connections
// as browsers keep to a host), whose connections reach the pinned address
// whatever the resolver says now: a direct one through a `lookup` that
// answers with it, a proxied one through a tunnel to it, TLS over the
// tunnel by the host's name. Node's Agent already returns a connection to
// the pool only once its response has been read to the end and the server
// meant to keep it, drops one the server closes or that errors while idle,
// and closes one idle past its timeout, the server's Keep-Alive hint if
// shorter; the pool adds the key, a bound on idle connections all told,
// and destroy(), which ends every connection, as a page goes, reloads or
// the app quits.
//
// Without Electron, so that node tests it (tests/desktop/http-pool.test.ts).
import { type AgentOptions, Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import type { ConnectionOptions } from "node:tls";
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
  /** Connections to one key at once, idle or in use; more requests wait for one. */
  perKey: number;
  /** How long an idle connection is kept, in milliseconds. */
  idle: number;
  /** Idle connections kept all told, past which a connection freed is closed. */
  idleTotal: number;
}

const POOL_LIMITS: PoolLimits = { perKey: 6, idle: 4_000, idleTotal: 64 };

/** A lookup that answers `address` whatever it is asked: the request's pin. */
function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_name, options, callback) => {
    if ((options as { all?: boolean }).all) {
      (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address, family },
      ]);
    } else {
      (callback as (e: null, a: string, f: number) => void)(null, address, family);
    }
  };
}

type Create = (options: object, done: (error: Error | null, socket?: Duplex) => void) => unknown;

export class ConnectionPool {
  private readonly agents = new Map<string, HttpAgent>();
  private readonly served = new WeakSet<object>();
  private readonly ca: string | string[] | undefined;
  private readonly proxy: ProxyConfig | null;
  private readonly limits: PoolLimits;
  /** Aborted by destroy(): tunnels still being made are given up. */
  private closing = new AbortController();
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

  /** The Agent of `target`'s key, made where none is. */
  agent(target: PoolTarget): HttpAgent {
    const key = [
      target.secure ? "https" : "http",
      target.host,
      target.address,
      target.port,
      this.route,
      target.secure ? (target.unverified ? "unverified" : "verified") : "",
    ].join(" ");
    let agent = this.agents.get(key);
    if (!agent) {
      agent = this.make(key, target);
      this.agents.set(key, agent);
    }

    return agent;
  }

  /**
   * Whether `socket` served a request before this one, which it is now
   * taken for: kept idle, or handed straight from the last request to one
   * waiting for its key, which Node's reusedSocket does not tell.
   */
  serves(socket: object): boolean {
    const before = this.served.has(socket);
    this.served.add(socket);
    return before;
  }

  /** Idle connections, all keys told. */
  idle(): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      for (const sockets of Object.values(agent.freeSockets)) {
        count += sockets?.length ?? 0;
      }
    }

    return count;
  }

  /** Every connection closed, idle or in use, and every tunnel being made given up. */
  destroy(): void {
    this.closing.abort();
    this.closing = new AbortController();
    for (const agent of this.agents.values()) {
      agent.destroy();
    }

    this.agents.clear();
  }

  private make(key: string, target: PoolTarget): HttpAgent {
    const tls: ConnectionOptions = target.secure
      ? {
          ...(this.ca ? { ca: this.ca } : {}),
          ...(isIP(target.host) ? {} : { servername: target.host }),
          // Only where the user asked for this host: its certificate goes unchecked.
          ...(target.unverified ? { rejectUnauthorized: false } : {}),
        }
      : {};
    // An Agent's options override each request's, so its connections are its key's alone.
    const options: AgentOptions & ConnectionOptions = {
      keepAlive: true,
      keepAliveMsecs: 1_000,
      maxSockets: this.limits.perKey,
      maxFreeSockets: this.limits.perKey,
      timeout: this.limits.idle,
      ...tls,
      ...(this.proxy ? {} : { lookup: pinnedLookup(target.address) }),
    };
    const agent = target.secure ? new HttpsAgent(options) : new HttpAgent(options);
    const base = (agent.createConnection as Create).bind(agent);
    const proxy = this.proxy;
    const closing = this.closing.signal;
    const opened = (socket: Duplex) => {
      this.opened++;
      socket.once("close", () => setImmediate(() => this.prune(key, agent)));
    };
    (agent as unknown as { createConnection: Create }).createConnection = (connection, done) => {
      if (!proxy) {
        const socket = base(connection, done) as Duplex;
        opened(socket);
        return socket;
      }

      // Through the proxy to the pinned address, TLS over the tunnel for https.
      connectThrough(proxy, target.address, target.port, { signal: closing }).then(
        (tunnel) => {
          // Made as the pool closed: no connection outlives it.
          if (closing.aborted) {
            tunnel.destroy();
            done(new Refused("aborted"));
            return;
          }

          const socket = target.secure
            ? (base({ ...connection, socket: tunnel }, () => {}) as Duplex)
            : tunnel;
          opened(socket);
          done(null, socket);
        },
        (error: ProxyError) => done(new Refused(error.message, { cause: error })),
      );
      return undefined;
    };
    const keep = agent.keepSocketAlive.bind(agent) as (socket: Duplex) => boolean;
    (agent as unknown as { keepSocketAlive: typeof keep }).keepSocketAlive = (socket) =>
      this.idle() < this.limits.idleTotal && keep(socket);
    return agent;
  }

  /** `agent` forgotten once it has no connection nor request left. */
  private prune(key: string, agent: HttpAgent): void {
    const empty = (sockets: NodeJS.ReadOnlyDict<unknown[]>) =>
      Object.values(sockets).every((list) => !list?.length);
    if (
      this.agents.get(key) === agent &&
      empty(agent.sockets) &&
      empty(agent.freeSockets) &&
      empty(agent.requests)
    ) {
      this.agents.delete(key);
    }
  }
}
