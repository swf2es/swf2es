// The network a SWF reaches through the desktop app: its http and https
// requests, sent by the main process and judged as Flash Player judged
// them, by its sandbox and the sites' policy files rather than CORS; with
// none of the user's credentials, and nothing more private than the SWF
// reached without that address's grant. --ignore-policy-files stands in
// for policy files' answers (network-rules.ts' policyIgnored), never for
// the rest. The rules, the pool, the cache and the proxy are in
// docs/architecture/desktop.md ("The network"); the types and limits in
// network-types.ts, the rules that need no instance in network-rules.ts.
//
// Without Electron, so that node tests it (tests/desktop/network.test.ts).
import { lookup } from "node:dns/promises";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, isIP, type Socket } from "node:net";
import { type AddressClass, addressClass, RANK } from "./addresses.ts";
import { DECODED, Decompressor } from "./decompress.ts";
import { type CacheEntry, type CacheRequest, type HttpCache, servedHeaders } from "./http-cache.ts";
import { ConnectionPool } from "./http-pool.ts";
import {
  abortable,
  bare,
  cached,
  checkPort,
  defaultCa,
  describe,
  type HostList,
  hostOf,
  policyIgnored,
  proxyFault,
  redirectOf,
  refererFor,
} from "./network-rules.ts";
import {
  type Budget,
  LIMITS,
  type Limits,
  type Movie,
  type NetProgress,
  type NetRequest,
  type NetResponse,
  type NetworkOptions,
  type Origin,
  type Pinned,
  Refused,
  type Session,
} from "./network-types.ts";
import {
  allowsAccess,
  allowsHeaders,
  allowsSocket,
  forbiddenHeader,
  parsePolicy,
  policyContentType,
  type Requester,
  type SocketPolicy,
  socketMetaPolicy,
  type UrlPolicy,
  urlMetaPolicy,
  usablePolicies,
} from "./policy.ts";
import { connectThrough, type ProxyConfig, type ProxyError } from "./proxy.ts";

const textDecoder = new TextDecoder();

/** What Flash Player 32 reported, sent as it sent it. */
const FLASH_VERSION = "32,0,0,465";
const USER_AGENT = "Mozilla/5.0 (compatible; swf2es) Shockwave Flash";
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface SendOptions {
  read: boolean;
  /** Whether a response whose status is 400 or more is read too. */
  errorBody?: boolean;
  max: number;
  referer: string | null;
  timeout?: number;
  deadline?: number;
  /** Where the bytes read count against the movie's `buffered`; a policy file's do not. */
  budget?: Budget;
  /** Whose HTTP cache answers and keeps it (partitionOf); none, where absent. */
  partition?: string;
  /** A policy file's fetch: fresh only as long as its server says. */
  policyFile?: boolean;
  /** Told of the body as it comes, where it is read; a stored one comes whole. */
  progress?: NetProgress;
}

/**
 * Whose cache a movie's requests use: its origin, as a browser partitions
 * its cache by site, so that no movie reads or probes another origin's;
 * the URL it was opened by until it has come. Local movies share one, and
 * applications another.
 */
function partitionOf(session: Session): string {
  const movie = session.movie;
  switch (movie.kind) {
    case "remote":
      return session.origin?.url.origin ?? new URL(movie.url).origin;
    case "local":
      return "local";
    case "application":
      return "application";
  }
}

/** The headers a request goes with: the SWF's own over what every request sends. */
function outgoingHeaders(
  headers: [string, string][],
  referer: string | null,
): Record<string, string> {
  const outgoing: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "*/*",
    "x-flash-version": FLASH_VERSION,
  };
  if (referer) {
    outgoing.Referer = referer;
  }

  for (const [name, value] of headers) {
    outgoing[name] = value;
  }

  return outgoing;
}

export class Network {
  private readonly limits: Limits;
  private readonly resolveHost: (host: string) => Promise<string[]>;
  private readonly classify: (address: string) => AddressClass | null;
  private readonly ca: string | string[] | undefined;
  private readonly unverified: (host: string) => boolean;
  private readonly ignorePolicy: HostList | null;
  private readonly socketPolicyPort: number;
  private readonly proxy: ProxyConfig | null;
  /** The keep-alive connections requests share (http-pool.ts), closed with each page. */
  readonly pool: ConnectionPool;
  private session: Session | null = null;
  /** What answers a GET in place of the network where it can; none by default, or when turned off. */
  cache: HttpCache | null = null;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(options: NetworkOptions = {}) {
    this.limits = { ...LIMITS, ...options.limits };
    this.resolveHost =
      options.resolve ??
      (async (host) =>
        (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address));
    this.classify = options.classify ?? addressClass;
    this.ca = options.ca ?? defaultCa();
    this.unverified = options.unverified ?? (() => false);
    this.ignorePolicy = options.ignorePolicy ?? null;
    this.socketPolicyPort = options.socketPolicyPort ?? 843;
    this.proxy = options.proxy ?? null;
    this.pool = new ConnectionPool({ ca: this.ca, proxy: this.proxy, limits: options.pool });
  }

  /**
   * Judge requests for `movie` from now on, or for none: what the last
   * movie had under way is aborted, its policy files forgotten and its
   * connections closed.
   */
  play(movie: Movie | null): void {
    this.session?.abort.abort();
    this.pool.destroy();
    this.session = movie
      ? {
          movie,
          origin: null,
          abort: new AbortController(),
          policies: new Map(),
          socketPolicies: new Map(),
          urlPolicyFiles: [],
          socketPolicyFiles: [],
          buffered: 0,
        }
      : null;
  }

  /** Every request aborted and every connection closed, as the app quits. */
  close(): void {
    this.play(null);
  }

  /** The movie's URL after its redirects, once it has come; null before, and for a local movie. */
  get origin(): string | null {
    return this.session?.origin?.url.href ?? null;
  }

  /**
   * A policy file the movie named with Security.loadPolicyFile: an http(s)
   * URL, or "xmlsocket://host:port" for a socket policy. It is fetched
   * only when a request needs it.
   */
  addPolicyFile(text: unknown): void {
    const session = this.session;
    if (
      !session ||
      typeof text !== "string" ||
      text.length > this.limits.url ||
      session.urlPolicyFiles.length + session.socketPolicyFiles.length >= this.limits.policyFiles
    ) {
      return;
    }

    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return;
    }

    if (url.protocol === "xmlsocket:") {
      const port = Number(url.port);
      if (url.hostname && Number.isInteger(port) && port > 0) {
        // Lower case by hand: the URL standard keeps an unknown scheme's host as written.
        session.socketPolicyFiles.push({ host: bare(url.hostname).toLowerCase(), port });
      }
    } else if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !session.urlPolicyFiles.some((u) => u.href === url.href)
    ) {
      url.hash = "";
      session.urlPolicyFiles.push(url);
    }
  }

  /**
   * Send what the page asks, `request` as it came over IPC, checked here,
   * if the movie may; `signal` aborts it. Refused, it throws a Refused
   * saying why. `deliver` is handed the response while its bytes still
   * count against the movie's budget, for a caller that copies them away
   * (over IPC) before they are given back. `progress` is told of the body
   * of what the SWF loads as it comes.
   */
  async fetch(
    request: unknown,
    signal: AbortSignal,
    deliver?: (response: NetResponse) => void,
    progress?: NetProgress,
  ): Promise<NetResponse> {
    const session = this.session;
    if (!session) {
      throw new Refused("no SWF plays");
    }

    const checked = this.check(request);
    const aborted = AbortSignal.any([signal, session.abort.signal]);
    await this.turn(aborted);
    // All told, from its turn: its redirects and the policy files it waits on included.
    const deadline = AbortSignal.timeout(this.limits.deadline);
    const bounded = AbortSignal.any([aborted, deadline]);
    const budget: Budget = { session, taken: 0 };
    try {
      const response =
        checked.purpose === "movie"
          ? await this.fetchMovie(session, checked, bounded, budget)
          : await this.fetchFor(session, checked, bounded, budget, progress);
      deliver?.(response);
      return response;
    } catch (error) {
      throw deadline.aborted && !aborted.aborted ? new Refused("it took too long") : error;
    } finally {
      session.buffered -= budget.taken;
      this.done();
    }
  }

  /**
   * The address the movie's socket to `host`:`port` connects to, once its
   * socket policy allows it, as Flash Player 9.0.124 and later asked of
   * every socket a remote SWF opened, its own server's included: the
   * master policy on port 843, then, as its meta-policy allows, those
   * Security.loadPolicyFile named and the one on the port itself. Each
   * fetched from the address the socket then connects to.
   */
  async socketAddress(host: string, port: number): Promise<string> {
    return (await this.socketGrant(host, port)).address;
  }

  /**
   * socketAddress's address, and whether --ignore-policy-files let the
   * socket through in place of a socket policy, for --log-network.
   */
  async socketGrant(
    host: string,
    port: number,
  ): Promise<{ address: string; policyIgnored: boolean }> {
    const session = this.session;
    const origin = session?.origin;
    if (!session || !origin) {
      throw new Refused("the SWF has not loaded");
    }

    // All told, its DNS and the policies of every port it tries included,
    // each of which it stops waiting on when time is up.
    const deadline = AbortSignal.timeout(this.limits.deadline);
    try {
      return await this.socketPolicyAddress(session, origin, host, port, deadline);
    } catch (error) {
      throw deadline.aborted ? new Refused("it took too long") : error;
    }
  }

  private async socketPolicyAddress(
    session: Session,
    origin: Origin,
    host: string,
    port: number,
    deadline: AbortSignal,
  ): Promise<{ address: string; policyIgnored: boolean }> {
    // The host as a URL would have it, resolved as such, so that the switch judges the very
    // name resolved; one that is no host alone is resolved as given, and never granted by it.
    const name = hostOf(host);
    const target = await this.pin(name ?? host, deadline);
    if (name !== null && policyIgnored(this.ignorePolicy, name, target.place)) {
      return { address: target.address, policyIgnored: true };
    }

    const policy = (at: number, timeout: number) =>
      abortable(
        cached(session.socketPolicies, `${target.address}|${at}`, () =>
          this.socketPolicy(target.address, at, timeout, session.abort.signal),
        ),
        deadline,
      );
    const master = await policy(this.socketPolicyPort, this.limits.masterSocketTimeout);
    if (allowsSocket(master, [], origin.requester, port)) {
      return { address: target.address, policyIgnored: false };
    }

    if (socketMetaPolicy(master) === "all") {
      const ports = [
        ...session.socketPolicyFiles
          .filter((f) => f.host === bare(host).toLowerCase())
          .map((f) => f.port),
        port,
      ];
      for (const at of new Set(ports)) {
        if (at === this.socketPolicyPort) {
          continue;
        }

        const other = await policy(at, this.limits.policyTimeout);
        if (other && allowsSocket(master, [other], origin.requester, port)) {
          return { address: target.address, policyIgnored: false };
        }
      }
    }

    throw new Refused(`no socket policy on ${host} grants ${describe(origin.requester)}`);
  }

  /** `request` checked and made plain: only what Flash Player let a SWF send. */
  private check(request: unknown): NetRequest & { target: URL } {
    const r = request as Partial<NetRequest> | null;
    if (typeof r !== "object" || r === null || typeof r.url !== "string") {
      throw new Refused("not a request");
    }

    if (r.url.length > this.limits.url) {
      throw new Refused("its URL is too long");
    }

    let target: URL;
    try {
      target = new URL(r.url);
    } catch {
      throw new Refused("not a URL");
    }

    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Refused(`no ${target.protocol} URL is fetched for a SWF`);
    }

    if (target.username || target.password) {
      throw new Refused("a URL with credentials");
    }

    target.hash = "";
    const purpose = r.purpose;
    if (purpose !== "movie" && purpose !== "content" && purpose !== "data" && purpose !== "send") {
      throw new Refused("no purpose");
    }

    // Flash Player outside AIR sent GET and POST only.
    const method = typeof r.method === "string" ? r.method.toUpperCase() : "";
    if (method !== "GET" && method !== "POST") {
      throw new Refused(`no ${String(r.method)} request is sent for a SWF`);
    }

    const body = method === "POST" && r.body instanceof Uint8Array ? r.body : null;
    if (body && body.length > this.limits.body) {
      throw new Refused("its body is too large");
    }

    const headers: [string, string][] = [];
    let bytes = 0;
    if (!Array.isArray(r.headers) || r.headers.length > this.limits.headers) {
      throw new Refused("too many headers");
    }

    for (const header of r.headers as unknown[]) {
      if (!Array.isArray(header) || header.length !== 2) {
        throw new Refused("not a header");
      }

      const [name, value] = header as unknown[];
      if (typeof name !== "string" || typeof value !== "string" || !TOKEN.test(name)) {
        throw new Refused("not a header");
      }

      // No control characters, line breaks among them, which would start a header of
      // their own, and nothing HTTP's Latin-1 does not hold: what Node would throw for.
      if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) {
        throw new Refused(`the header ${name} has a character no header may hold`);
      }

      if (forbiddenHeader(name)) {
        throw new Refused(`a SWF may not send the header ${name}`);
      }

      bytes += name.length + value.length;
      headers.push([name, value]);
    }

    if (bytes > this.limits.headerBytes) {
      throw new Refused("its headers are too long");
    }

    return {
      url: target.href,
      target,
      method,
      headers,
      body,
      purpose,
      ...(r.errorBody === true ? { errorBody: true } : {}),
    };
  }

  /** Wait for a turn among the requests under way: at most `concurrent` at once. */
  private async turn(signal: AbortSignal): Promise<void> {
    if (this.running < this.limits.concurrent) {
      this.running++;
      return;
    }

    if (this.waiting.length >= this.limits.queue) {
      throw new Refused("too many requests at once");
    }

    await new Promise<void>((go, fail) => {
      const start = () => {
        signal.removeEventListener("abort", stop);
        go();
      };
      const stop = () => {
        const at = this.waiting.indexOf(start);
        if (at >= 0) {
          this.waiting.splice(at, 1);
        }

        fail(new Refused("aborted"));
      };
      if (signal.aborted) {
        stop();
        return;
      }

      signal.addEventListener("abort", stop, { once: true });
      this.waiting.push(start);
    });
    this.running++;
  }

  private done(): void {
    this.running--;
    this.waiting.shift()?.();
  }

  /** `host`'s address, its resolver's first, and how private; refused where none is reached. */
  private async pin(host: string, signal?: AbortSignal): Promise<Pinned> {
    const name = bare(host);
    let address: string;
    if (isIP(name)) {
      address = name;
    } else {
      let addresses: string[];
      try {
        addresses = await (signal
          ? abortable(this.resolveHost(name), signal)
          : this.resolveHost(name));
      } catch {
        throw new Refused(signal?.aborted ? "aborted" : `${name} has no address`);
      }

      if (addresses.length === 0) {
        throw new Refused(`${name} has no address`);
      }

      address = addresses[0];
    }

    const place = this.classify(address);
    if (place === null) {
      throw new Refused(`${name} is at ${address}, which no request reaches`);
    }

    return { address, place, rank: RANK[place] };
  }

  /** The movie's SWF, from wherever the user asked; no redirect takes it somewhere more private. */
  private async fetchMovie(
    session: Session,
    request: NetRequest & { target: URL },
    signal: AbortSignal,
    budget: Budget,
  ): Promise<NetResponse> {
    const movie = session.movie;
    if (movie.kind !== "remote" || request.url !== new URL(movie.url).href) {
      throw new Refused("not the SWF that was opened");
    }

    let url = request.target;
    let first: number | null = null;
    for (let hop = 0; hop <= this.limits.redirects; hop++) {
      const target = await this.pin(url.hostname, signal);
      checkPort(url);
      first ??= target.rank;
      if (target.rank > first) {
        throw new Refused(`a redirect to ${url.href}, somewhere more private`);
      }

      const response = await this.exchange(url, target.address, "GET", [], null, signal, {
        read: true,
        max: this.limits.response,
        referer: null,
        budget,
        partition: partitionOf(session),
      });
      const next = redirectOf(url, response);
      if (next) {
        url = next;
        continue;
      }

      if (response.bytes) {
        session.origin = {
          url,
          requester: { host: bare(url.hostname).toLowerCase(), scheme: url.protocol.slice(0, -1) },
          rank: target.rank,
        };
      }

      return { ...response, ...(url.href === request.url ? {} : { url: url.href }) };
    }

    throw new Refused("too many redirects");
  }

  /** A request of the SWF's, each hop of its redirects judged as if asked for itself. */
  private async fetchFor(
    session: Session,
    request: NetRequest & { target: URL },
    signal: AbortSignal,
    budget: Budget,
    progress?: NetProgress,
  ): Promise<NetResponse> {
    let requester: Requester;
    let rank: number;
    let origin: string | null;
    const application = session.movie.kind === "application";
    if (application) {
      requester = { host: null, scheme: null };
      // Nothing is more private than an application: it reaches its own machine too.
      rank = Number.POSITIVE_INFINITY;
      origin = null;
    } else if (session.movie.kind === "local") {
      requester = { host: null, scheme: null };
      // A local SWF stands for nothing on the network: it reaches no private address of itself.
      rank = RANK.public;
      origin = null;
    } else if (session.origin) {
      ({ requester, rank } = session.origin);
      origin = session.origin.url.origin;
    } else {
      throw new Refused("the SWF has not loaded");
    }

    let { method, headers, body } = request;
    let url = request.target;
    // Whether --ignore-policy-files stood in for a policy on the way.
    let ignored = false;
    for (let hop = 0; hop <= this.limits.redirects; hop++) {
      checkPort(url);
      const target = await this.pin(url.hostname, signal);
      const same = origin === url.origin;
      const morePrivate = target.rank > rank;
      const custom = headers.map(([n]) => n).filter((n) => n.toLowerCase() !== "content-type");
      const needsAccess = !application && (morePrivate || (!same && request.purpose === "data"));
      const needsHeaders = !application && !same && custom.length > 0;
      const needsPolicy = needsAccess || needsHeaders;
      if (needsPolicy && policyIgnored(this.ignorePolicy, url.hostname, target.place)) {
        ignored = true;
      } else if (needsPolicy) {
        const policies = await abortable(this.policiesFor(session, url, target.address), signal);
        if (needsAccess && !allowsAccess(policies, requester, url)) {
          throw new Refused(
            morePrivate
              ? `${url.host} is at ${target.address}, more private than the SWF, ` +
                  `and no policy file there grants ${describe(requester)}` +
                  // The switch alone never reaches it: said, so that the user knows to name it.
                  (this.ignorePolicy ? " (--ignore-policy-files reaches it only by name)" : "")
              : `no policy file on ${url.origin} grants ${describe(requester)}`,
          );
        }

        if (needsHeaders && !allowsHeaders(policies, requester, url, custom)) {
          throw new Refused(`no policy file on ${url.origin} lets it send ${custom.join(", ")}`);
        }
      }

      // Its head as the response will have it: the URL redirects took it to.
      const moved = url.href === request.url ? {} : { url: url.href };
      const response = await this.exchange(url, target.address, method, headers, body, signal, {
        // sendToURL's answer is no one's to read.
        read: request.purpose !== "send",
        ...(progress && {
          progress: {
            open: (head, total) => progress.open({ ...head, ...moved }, total),
            data: progress.data,
          },
        }),
        // In AIR's application sandbox alone: Flash Player's fail such a load, with no data.
        errorBody: application && request.errorBody === true,
        max: this.limits.response,
        budget,
        referer: refererFor(session.origin?.url ?? null, url),
        partition: partitionOf(session),
      });
      const next = redirectOf(url, response);
      if (!next) {
        return { ...response, ...moved, ...(ignored ? { policyIgnored: true } : {}) };
      }

      // As browsers do: a 303, and a 301 or 302 after a POST, go on as a GET without the body.
      if (response.status === 303 || (method === "POST" && response.status <= 302)) {
        method = "GET";
        body = null;
        headers = [];
      }

      url = next;
    }

    throw new Refused("too many redirects");
  }

  /**
   * The policy files of `url`'s site that count, fetched from `address`:
   * its master policy file, and those the movie named under it as the
   * master's meta-policy allows. Each is fetched once a movie and address,
   * and aborted only with the movie, not with the request that first asked:
   * the next finds it as it came.
   */
  private async policiesFor(session: Session, url: URL, address: string): Promise<UrlPolicy[]> {
    const get = (policyUrl: URL) =>
      cached(session.policies, `${policyUrl.href}|${address}`, () =>
        this.urlPolicy(policyUrl, address, session.abort.signal, partitionOf(session)),
      );
    const master = await get(new URL("/crossdomain.xml", url.origin));
    const meta = urlMetaPolicy(master);
    const others: UrlPolicy[] = [];
    if (meta === "all" || meta === "by-content-type") {
      for (const named of session.urlPolicyFiles) {
        const directory = named.pathname.slice(0, named.pathname.lastIndexOf("/") + 1);
        if (
          named.origin === url.origin &&
          named.pathname !== "/crossdomain.xml" &&
          url.pathname.startsWith(directory)
        ) {
          const other = await get(named);
          if (other) {
            others.push(other);
          }
        }
      }
    }

    return usablePolicies(master, others);
  }

  /** A URL policy file, or null: missing, redirected, mistyped, refusing to be one, or none. */
  private async urlPolicy(
    url: URL,
    address: string,
    signal: AbortSignal,
    partition: string,
  ): Promise<UrlPolicy | null> {
    let response: NetResponse;
    try {
      response = await this.exchange(url, address, "GET", [], null, signal, {
        read: true,
        max: this.limits.policy,
        referer: null,
        partition,
        policyFile: true,
        timeout: this.limits.policyTimeout,
        deadline: this.limits.policyTimeout,
      });
    } catch (error) {
      // A proxy that failed is said, as the request that needed the policy fails;
      // a server the proxy did not reach has no policy, as one that is not there.
      if (proxyFault(error)) {
        throw error;
      }

      return null;
    }

    // Redirects are not followed: the specification ignores one to another
    // domain, and one within a site would move the file's scope.
    if (response.status !== 200 || !response.bytes) {
      return null;
    }

    const header = (name: string) =>
      response.headers
        .filter(([n]) => n.toLowerCase() === name)
        .flatMap(([, v]) => v.split(","))
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v !== "");
    const contentType = (header("content-type")[0] ?? "").split(";")[0].trim();
    const permitted = header("x-permitted-cross-domain-policies");
    if (!policyContentType(contentType) || permitted.includes("none-this-response")) {
      return null;
    }

    const policy = parsePolicy(textDecoder.decode(response.bytes));
    return policy && { policy, url, contentType, permitted };
  }

  /**
   * A socket policy: a connection to `address`:`port` that asks for one
   * with <policy-file-request/> and its NUL, and reads the answer up to
   * its NUL or its close; null where none comes in `timeout`.
   */
  private socketPolicy(
    address: string,
    port: number,
    timeout: number,
    signal: AbortSignal,
  ): Promise<SocketPolicy | null> {
    return new Promise((answer, fail) => {
      const chunks: Buffer[] = [];
      let length = 0;
      let socket: Socket | null = null;
      let finished = false;
      const opening = new AbortController();
      const finish = (policy: SocketPolicy | null, error?: Error) => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        opening.abort();
        socket?.destroy();
        if (error) {
          fail(error);
        } else {
          answer(policy);
        }
      };
      const read = () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const policy = parsePolicy(text.split("\0")[0]);
        finish(policy && { policy, port });
      };
      const abort = () => finish(null);
      const timer = setTimeout(abort, timeout);
      signal.addEventListener("abort", abort, { once: true });
      const talk = (connected: Socket) => {
        socket = connected;
        connected.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > this.limits.policy) {
            finish(null);
            return;
          }

          chunks.push(chunk);
          if (chunk.includes(0)) {
            read();
          }
        });
        connected.on("end", read);
        connected.on("error", () => finish(null));
      };

      if (!this.proxy) {
        const direct = connect({ host: address, port });
        talk(direct);
        direct.on("connect", () => direct.write("<policy-file-request/>\0"));
        return;
      }

      connectThrough(this.proxy, address, port, { signal: opening.signal }).then(
        (tunnel) => {
          if (finished) {
            tunnel.destroy();
            return;
          }

          talk(tunnel);
          tunnel.write("<policy-file-request/>\0");
        },
        (error: ProxyError) =>
          // A server the proxy did not reach has no policy; a proxy that failed is said.
          finish(null, error.fault ? new Refused(error.message, { cause: error }) : undefined),
      );
    });
  }

  /**
   * A hop's answer from the cache where it may give one (fresh, or
   * confirmed by a 304), else from send(), kept where it may be. Only a GET
   * whose body is read is asked of it; a POST that succeeds forgets what
   * its URL had (RFC 9111, 4.4).
   */
  private async exchange(
    url: URL,
    address: string,
    method: string,
    headers: [string, string][],
    body: Uint8Array | null,
    signal: AbortSignal,
    options: SendOptions,
  ): Promise<NetResponse> {
    const cache = this.cache;
    const partition = options.partition;
    if (
      !cache ||
      partition === undefined ||
      // Unverified, as --ignore-certificate-errors leaves it: whoever was on the way may have
      // written it, and nothing so written outlives the run that allowed it.
      (url.protocol === "https:" && this.unverified(bare(url.hostname))) ||
      // A grant only one network's machines make, which on another the same address is not.
      (options.policyFile && this.classify(address) !== "public")
    ) {
      return this.send(url, address, method, headers, body, signal, options);
    }

    if (method !== "GET") {
      const response = await this.send(url, address, method, headers, body, signal, options);
      cache.invalidate(url, response, partition);
      return response;
    }

    const request: CacheRequest = {
      method,
      url: url.href,
      headers: Object.entries(outgoingHeaders(headers, options.referer)),
      address,
      partition,
      // An address is a machine only along one way to it: through a proxy, another may be.
      route: this.pool.route,
      policyFile: options.policyFile === true,
    };
    if (!options.read || !cache.handles(request)) {
      return this.send(url, address, method, headers, body, signal, options);
    }

    const found = cache.lookup(request);
    if (found?.fresh) {
      const bytes = await this.storedBody(cache, found, signal, options);
      if (bytes) {
        return { bytes, status: found.status, headers: servedHeaders(found), cache: "hit" };
      }
    }

    const conditional = found && !found.fresh ? found.conditional : [];
    const response = await this.send(
      url,
      address,
      method,
      [...headers, ...conditional],
      body,
      signal,
      options,
    );
    if (found && conditional.length > 0 && response.status === 304) {
      const refreshed = cache.revalidated(found, request, response);
      const bytes = refreshed && (await this.storedBody(cache, refreshed, signal, options));
      if (refreshed && bytes) {
        return {
          bytes,
          status: refreshed.status,
          headers: servedHeaders(refreshed),
          cache: "revalidated",
          ...(response.reused ? { reused: true } : {}),
        };
      }

      // What the 304 was to confirm is gone, or does not match: asked again, whole.
      const whole = await this.send(url, address, method, headers, body, signal, options);
      void cache.store(request, whole);
      return whole;
    }

    void cache.store(request, response);
    return response;
  }

  /**
   * A stored body, counted as a response's against `max` and the movie's
   * budget; null where its file is not what was stored.
   */
  private async storedBody(
    cache: HttpCache,
    entry: CacheEntry,
    signal: AbortSignal,
    options: SendOptions,
  ): Promise<Uint8Array | null> {
    if (entry.size > options.max) {
      throw new Refused(`its response is larger than ${options.max} bytes`);
    }

    const budget = options.budget;
    if (budget) {
      if (budget.session.buffered + entry.size > this.limits.buffered) {
        throw new Refused("the SWF's responses under way hold too much at once");
      }

      budget.session.buffered += entry.size;
      budget.taken += entry.size;
    }

    const bytes = await cache.body(entry);
    if (!bytes && budget) {
      budget.session.buffered -= entry.size;
      budget.taken -= entry.size;
    }

    if (signal.aborted) {
      throw new Refused("aborted");
    }

    return bytes;
  }

  /**
   * One HTTP exchange with `address`, the URL's host pinned to it, over the
   * pool's connections (http-pool.ts); the body read only where `read` and
   * the status is a success, or an error with `errorBody`. No cookies, no
   * credentials, no compression asked for. A GET whose kept connection the
   * server closed as it was reused, before any answer, is sent once more,
   * as browsers do.
   */
  private send(
    url: URL,
    address: string,
    method: string,
    headers: [string, string][],
    body: Uint8Array | null,
    signal: AbortSignal,
    options: SendOptions,
  ): Promise<NetResponse> {
    const timeout = options.timeout ?? this.limits.timeout;
    const deadline = options.deadline ?? this.limits.deadline;
    return new Promise((answer, fail) => {
      if (signal.aborted) {
        fail(new Refused("aborted"));
        return;
      }

      const host = bare(url.hostname);
      const outgoing = outgoingHeaders(headers, options.referer);
      if (body) {
        outgoing["Content-Length"] = String(body.length);
      }

      const https = url.protocol === "https:";
      const port = Number(url.port || (https ? 443 : 80));
      const agent = this.pool.agent({
        secure: https,
        host,
        address,
        port,
        unverified: https && this.unverified(host),
      });
      const make = () =>
        (https ? httpsRequest : httpRequest)({
          host,
          port,
          path: `${url.pathname}${url.search}`,
          method,
          headers: outgoing,
          agent,
        });
      let request: ClientRequest;
      try {
        request = make();
      } catch (error) {
        // What check() let through and Node still refuses: a refusal like any other.
        fail(new Refused((error as Error).message));
        return;
      }
      let timer: NodeJS.Timeout;
      const overall = setTimeout(() => stop(new Refused("it took too long")), deadline);
      let finished = false;
      let retried = false;
      /** What else a stop takes down: a decompressor. */
      const stopping: (() => void)[] = [];
      const stop = (error: Refused) => {
        if (!finished) {
          finished = true;
          for (const down of stopping) {
            down();
          }

          clearTimeout(timer);
          clearTimeout(overall);
          signal.removeEventListener("abort", abort);
          request.destroy();
          fail(error);
        }
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stop(new Refused("it timed out")), timeout);
      };
      const abort = () => stop(new Refused("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      arm();
      /**
       * The connection back to the pool once its response is read to the
       * end, an unread one drained where small so that a redirect's next hop
       * may reuse it; any other closed. Timers and abort hold until then.
       */
      let releasing = false;
      const release = (response: IncomingMessage, then: () => void) => {
        if (releasing) {
          return;
        }

        releasing = true;
        if (response.complete) {
          then();
          return;
        }

        if (Number(response.headers["content-length"]) > this.limits.drainBytes) {
          request.destroy();
          then();
          return;
        }

        // A chunked body past the bound, or a slow one, closes it instead.
        const draining = request;
        let settled = false;
        let drained = 0;
        const settle = () => {
          if (!settled) {
            settled = true;
            clearTimeout(late);
            then();
          }
        };
        const late = setTimeout(() => {
          draining.destroy();
          settle();
        }, this.limits.drainTime);
        response.on("data", (chunk: Buffer) => {
          drained += chunk.length;
          // What has come whole leaves the connection clean, however long.
          if (drained > this.limits.drainBytes && !response.complete) {
            draining.destroy();
            settle();
            return;
          }

          arm();
        });
        response.on("end", settle);
        response.on("close", settle);
        response.on("error", () => {});
      };
      let reused = false;
      const wire = (current: ClientRequest) => {
        let answered = false;
        current.on("socket", (socket) => {
          if (current === request) {
            reused = this.pool.serves(socket);
          }
        });
        current.on("error", (error) => {
          if (current !== request) {
            return;
          }

          if (
            !answered &&
            !retried &&
            !finished &&
            method === "GET" &&
            reused &&
            ((error as NodeJS.ErrnoException).code === "ECONNRESET" ||
              (error as NodeJS.ErrnoException).code === "EPIPE")
          ) {
            retried = true;
            try {
              request = make();
            } catch (again) {
              stop(new Refused((again as Error).message));
              return;
            }

            wire(request);
            return;
          }

          // A proxy's refusal comes as it was made, with its cause.
          stop(error instanceof Refused ? error : new Refused(error.message));
        });
        current.on("response", (response: IncomingMessage) => {
          answered = true;
          respond(response);
        });
        current.end(body ?? undefined);
      };
      const respond = (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const received: [string, string][] = [];
        const raw = response.rawHeaders;
        for (let i = 0; i + 1 < raw.length; i += 2) {
          // The SWF has no cookie jar to keep them in.
          if (!/^set-cookie2?$/i.test(raw[i])) {
            received.push([raw[i], raw[i + 1]]);
          }
        }

        const wanted = (status >= 200 && status < 300) || (!!options.errorBody && status >= 400);
        const end = (bytes: Uint8Array | null) => {
          if (!finished) {
            release(response, () => {
              if (!finished) {
                finished = true;
                clearTimeout(timer);
                clearTimeout(overall);
                signal.removeEventListener("abort", abort);
                answer({ bytes, status, headers: received, ...(reused ? { reused: true } : {}) });
              }
            });
          }
        };
        if (!wanted || !options.read) {
          end(null);
          return;
        }

        const declared = Number(response.headers["content-length"]);
        if (declared > options.max) {
          stop(new Refused(`its response is larger than ${options.max} bytes`));
          return;
        }

        // A body a server compressed though no one asked: decompressed as it
        // comes, the limits counting what comes out. One coding is undone;
        // more than one, which no server needs, is refused.
        const codings = String(response.headers["content-encoding"] ?? "")
          .split(",")
          .map((c) => c.trim().toLowerCase())
          .filter((c) => c !== "" && c !== "identity");
        if (codings.length > 1) {
          stop(new Refused(`its response is encoded ${codings.length} times`));
          return;
        }

        const coding = codings[0] ?? "";
        const coded = DECODED.has(coding);
        if (coded) {
          const named = (n: string) => /^content-(encoding|length)$/i.test(n);
          received.splice(0, received.length, ...received.filter(([n]) => !named(n)));
        }

        // One array that doubles as it fills: a list of chunks would hold
        // hundreds of times the size of a body sent a byte at a time. Sized at
        // a believable declared length, it needs no copy at the end.
        const budget = options.budget;
        const exact = !coded && Number.isSafeInteger(declared) && declared >= 0;
        let body = new Uint8Array(0);
        let length = 0;
        const reserve = (capacity: number): boolean => {
          const more = capacity - body.length;
          if (budget) {
            if (budget.session.buffered + more > this.limits.buffered) {
              stop(new Refused("the SWF's responses under way hold too much at once"));
              return false;
            }

            budget.session.buffered += more;
            budget.taken += more;
          }

          const grown = new Uint8Array(capacity);
          grown.set(body.subarray(0, length));
          body = grown;
          return true;
        };
        if (exact && declared > 0 && !reserve(declared)) {
          return;
        }

        const progress = options.progress;
        progress?.open({ status, headers: received }, exact ? declared : 0);
        const take = (chunk: Buffer) => {
          if (finished) {
            return;
          }

          if (length + chunk.length > options.max) {
            stop(new Refused(`its response is larger than ${options.max} bytes`));
            return;
          }

          if (length + chunk.length > body.length) {
            const capacity = Math.min(
              options.max,
              Math.max(length + chunk.length, body.length * 2),
            );
            if (!reserve(capacity)) {
              return;
            }
          }

          body.set(chunk, length);
          length += chunk.length;
          arm();
          // A copy of its own: IPC would carry a pooled Buffer's whole memory.
          progress?.data(new Uint8Array(chunk));
        };
        // Bytes of their own, since IPC would carry a view's whole array; the
        // larger one let go so it may be collected before IPC copies.
        const done = () => {
          const bytes = length === body.length ? body : body.slice(0, length);
          body = new Uint8Array(0);
          end(bytes);
        };
        arm();
        if (!coded) {
          response.on("data", take);
          response.on("end", done);
        } else {
          const decompressor = new Decompressor(coding, take, done, () =>
            stop(new Refused("its response does not decompress")),
          );
          stopping.push(() => decompressor.destroy());
          decompressor.onDrain = () => response.resume();
          response.on("data", (chunk: Buffer) => {
            arm();
            if (!decompressor.write(chunk)) {
              response.pause();
            }
          });
          response.on("end", () => decompressor.end());
        }

        response.on("error", (error) => stop(new Refused(error.message)));
        response.on("aborted", () => stop(new Refused("the response broke off")));
      };
      wire(request);
    });
  }
}
