// The keep-alive connections network.ts's requests share, each handed only
// to a request that would have opened exactly that one. Its key is the
// scheme, the host's name (TLS's server name), the address the request
// pinned it to, the port, the route (direct, or the proxy by its kind, host
// and port, never its credentials) and, for https, whether the certificate
// goes unchecked (--ignore-certificate-errors). So a name that rebinds never
// gets a connection to its old address, a checked host never shares one made
// unchecked, and a tunnel serves only its own target.
//
// Each key is a Node Agent, its connections pinned by its options; the pool
// adds what the Agent lacks: tunnels still being made counted against the
// key's limit, a bound on idle connections all told, and destroy() for every
// connection it opened. The limits are in docs/architecture/desktop.md.
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
type AddRequest = (request: unknown, options: object) => void;
type CreateSocket = (
  request: unknown,
  options: object,
  done: (error: Error | null, socket?: Duplex) => void,
) => void;

export class ConnectionPool {
  private readonly agents = new Map<string, HttpAgent>();
  private readonly served = new WeakSet<object>();
  /** Every connection open, whichever agent holds it: what destroy() closes. */
  private readonly open = new Set<Duplex>();
  /** A proxied agent's tunnels still being made, which Node's Agent does not count. */
  private readonly building = new Map<HttpAgent, { count: number; name: string }>();
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

    // And any an agent no longer holds, should one have slipped past it.
    for (const socket of this.open) {
      socket.destroy();
    }

    this.agents.clear();
    this.building.clear();
    this.open.clear();
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
    const opened = (socket: Duplex) => {
      this.opened++;
      this.open.add(socket);
      socket.once("close", () => {
        this.open.delete(socket);
        setImmediate(() => this.prune(key, agent));
      });
    };
    const keep = agent.keepSocketAlive.bind(agent) as (socket: Duplex) => boolean;
    (agent as unknown as { keepSocketAlive: typeof keep }).keepSocketAlive = (socket) =>
      this.idle() < this.limits.idleTotal && keep(socket);
    const proxy = this.proxy;
    if (!proxy) {
      (agent as unknown as { createConnection: Create }).createConnection = (connection, done) => {
        const socket = base(connection, done) as Duplex;
        opened(socket);
        return socket;
      };
      return agent;
    }

    // Node's Agent counts a tunnel only once it is made: those still being made count here,
    // so that the key keeps to its limit and prune() keeps its agent.
    const building = { count: 0, name: "" };
    this.building.set(agent, building);
    const queued = (agent as unknown as { requests: Record<string, unknown[]> }).requests;
    const add = (agent as unknown as { addRequest: AddRequest }).addRequest.bind(agent);
    (agent as unknown as { addRequest: AddRequest }).addRequest = (request, more) => {
      const name = building.name;
      const free = (agent.freeSockets[name] ?? []).some((socket) => !socket.destroyed);
      const busy = agent.sockets[name]?.length ?? 0;
      if (building.count > 0 && !free && busy + building.count >= this.limits.perKey) {
        // Waits as Node's own queue waits, for the next connection freed, closed or failed.
        queued[name] ??= [];
        queued[name].push(request);
        return;
      }

      add(request, more);
    };
    const createSocket = (agent as unknown as { createSocket: CreateSocket }).createSocket.bind(
      agent,
    );
    /** A connection for the request first in the queue, where a tunnel that failed left room. */
    const next = (connection: object) => {
      const waiting = queued[building.name];
      const busy = agent.sockets[building.name]?.length ?? 0;
      if (!waiting?.length || busy + building.count >= this.limits.perKey) {
        return;
      }

      const request = waiting[0] as { onSocket(socket: null, error: Error): void };
      createSocket(request, connection, (error, socket) => {
        if (error) {
          const at = waiting.indexOf(request);
          if (at >= 0) {
            waiting.splice(at, 1);
          }

          request.onSocket(null, error);
          return;
        }

        // Node's Agent hands a connection freed to the first request waiting.
        socket?.emit("free");
      });
    };
    const closing = this.closing.signal;
    (agent as unknown as { createConnection: Create }).createConnection = (connection, done) => {
      building.name = (connection as { _agentKey?: string })._agentKey ?? "";
      building.count++;
      connectThrough(proxy, target.address, target.port, { signal: closing }).then(
        (tunnel) => {
          building.count--;
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
        (error: ProxyError) => {
          building.count--;
          done(new Refused(error.message, { cause: error }));
          if (!closing.aborted) {
            next(connection);
          }

          setImmediate(() => this.prune(key, agent));
        },
      );
      return undefined;
    };
    return agent;
  }

  /** `agent` forgotten once it has no connection, request nor tunnel being made left. */
  private prune(key: string, agent: HttpAgent): void {
    const empty = (sockets: NodeJS.ReadOnlyDict<unknown[]>) =>
      Object.values(sockets).every((list) => !list?.length);
    if (
      this.agents.get(key) === agent &&
      !this.building.get(agent)?.count &&
      empty(agent.sockets) &&
      empty(agent.freeSockets) &&
      empty(agent.requests)
    ) {
      this.agents.delete(key);
      this.building.delete(agent);
    }
  }
}
