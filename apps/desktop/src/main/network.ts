// The network a SWF reaches through the desktop app: every http and https
// request it makes, sent by the main process rather than the page, and
// judged as Flash Player judged it, by its sandbox and the policy files
// of the sites it reaches, not by CORS; and the socket policies a remote
// SWF's sockets need. So a SWF reaches http: and servers that never heard
// of CORS, as it did in Flash, and nothing it should not.
//
// - A remote SWF's own origin is open to it. Another origin's data it
//   reads as that origin's policy files grant its domain; content (a
//   Loader's, a Sound's) and what sendToURL sends go anywhere. A
//   local-with-networking SWF has no domain: only a policy granting "*"
//   lets it read data.
// - Nothing is sent with the user's credentials: no cookies, no
//   authentication, no client certificate. So all a SWF gains by asking
//   from here rather than its own server is this machine's place on the
//   network, and that is the one thing guarded beyond Flash's rules:
//   a request to an address more private than the SWF's own (addresses.ts)
//   needs a policy from that address granting it, whatever its purpose,
//   same origin or not. Each request resolves its host once and connects
//   to that address, its policy file fetched from the same one, so DNS
//   that changes its answer (rebinding) changes nothing.
// - Requests are bounded: methods, headers, sizes, redirects, time, and
//   how many run at once; and each movie's are aborted as the next opens.
//
// Without Electron, so that node tests it (tests/desktop/network.test.ts).
import { lookup } from "node:dns/promises";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, isIP, isIPv4 } from "node:net";
import type { Transform } from "node:stream";
import * as tls from "node:tls";
import { createBrotliDecompress, createInflate, createInflateRaw } from "node:zlib";
import { type AddressClass, addressClass, badPort, RANK } from "./addresses.ts";
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

export type Purpose = "movie" | "content" | "data" | "send";

export interface NetRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
  purpose: Purpose;
}

export interface NetResponse {
  bytes: Uint8Array | null;
  status: number;
  headers: [string, string][];
  /** Where redirects took it, where that differs from the URL asked for. */
  url?: string;
}

/** A request refused, with why, for the terminal; the SWF sees a failed load. */
export class Refused extends Error {}

export interface Limits {
  /** The longest URL. */
  url: number;
  /** The most headers a SWF sends, and their names' and values' length all told. */
  headers: number;
  headerBytes: number;
  /** The largest body a SWF sends. */
  body: number;
  /** The largest response read: a SWF, a sound, a level's data. */
  response: number;
  /** The largest policy file, URL or socket. */
  policy: number;
  redirects: number;
  /** From the request to its response's headers, and from one chunk of its body to the next. */
  timeout: number;
  /**
   * How long a request may take all told, however its bytes trickle in, so
   * that a server sending a byte a second holds no turn for long; a policy
   * file's whole fetch takes `policyTimeout` at most, as a movie keeps it.
   */
  deadline: number;
  /** How long a policy file may take, and port 843's socket policy, which most servers lack. */
  policyTimeout: number;
  masterSocketTimeout: number;
  /**
   * The bytes a movie's responses may hold at once, all told: past it a
   * response is refused, so many large ones together cannot take the
   * main process's memory, as each alone may come near `response`.
   */
  buffered: number;
  /** Requests under way at once; the rest wait their turn, up to `queue`. */
  concurrent: number;
  queue: number;
  /** Policy files a movie may name with Security.loadPolicyFile. */
  policyFiles: number;
}

export const LIMITS: Limits = {
  url: 64 * 1024,
  headers: 32,
  headerBytes: 8 * 1024,
  body: 32 * 1024 * 1024,
  response: 128 * 1024 * 1024,
  policy: 1024 * 1024,
  redirects: 10,
  timeout: 30_000,
  deadline: 300_000,
  policyTimeout: 10_000,
  masterSocketTimeout: 3_000,
  buffered: 256 * 1024 * 1024,
  concurrent: 16,
  queue: 1024,
  policyFiles: 64,
};

/** The movie whose requests are judged: a remote SWF by its URL, or a local one with networking. */
export type Movie = { kind: "remote"; url: string } | { kind: "local" };

export interface NetworkOptions {
  /** A host name's addresses, in order of preference: the system's resolver by default. */
  resolve?: (host: string) => Promise<string[]>;
  /** Where an address is: addresses.ts's by default; null for one never reached. */
  classify?: (address: string) => AddressClass | null;
  /** The certificate authorities HTTPS trusts, in place of Node's and the system's. */
  ca?: string | string[];
  limits?: Partial<Limits>;
  /** Where a socket server keeps its master policy: 843. */
  socketPolicyPort?: number;
}

/** What Flash Player 32 reported, sent as it sent it. */
const FLASH_VERSION = "32,0,0,465";
const USER_AGENT = "Mozilla/5.0 (compatible; swf2es) Shockwave Flash";

/** A remote movie once its SWF has come, where from. */
interface Origin {
  /** Its URL after redirects: its loaderInfo.url, and its Referer. */
  url: URL;
  requester: Requester;
  rank: number;
}

interface Pinned {
  address: string;
  rank: number;
}

/** What one movie's requests share, and lose as the next opens. */
/** What one request's responses hold of its movie's `buffered`, given back as it is answered. */
interface Budget {
  session: Session;
  taken: number;
}

interface Session {
  movie: Movie;
  origin: Origin | null;
  abort: AbortController;
  /** URL and socket policies, by where they came from and the address they came from. */
  policies: Map<string, Promise<UrlPolicy | null>>;
  socketPolicies: Map<string, Promise<SocketPolicy | null>>;
  /** What Security.loadPolicyFile named: http(s) URLs, and xmlsocket "host:port"s. */
  urlPolicyFiles: URL[];
  socketPolicyFiles: { host: string; port: number }[];
  /** The bytes its responses hold now, of `buffered`. */
  buffered: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The system's trusted roots beside Node's, where this Node can tell them. */
function defaultCa(): string[] | undefined {
  const get = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  if (typeof get !== "function") {
    return undefined;
  }

  try {
    return [...new Set([...get("default"), ...get("system")])];
  } catch {
    return undefined;
  }
}

export class Network {
  private readonly limits: Limits;
  private readonly resolveHost: (host: string) => Promise<string[]>;
  private readonly classify: (address: string) => AddressClass | null;
  private readonly ca: string | string[] | undefined;
  private readonly socketPolicyPort: number;
  private session: Session | null = null;
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
    this.socketPolicyPort = options.socketPolicyPort ?? 843;
  }

  /**
   * Judge requests for `movie` from now on, or for none: what the last
   * movie had under way is aborted, and its policy files forgotten.
   */
  play(movie: Movie | null): void {
    this.session?.abort.abort();
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
   * (over IPC) before they are given back.
   */
  async fetch(
    request: unknown,
    signal: AbortSignal,
    deliver?: (response: NetResponse) => void,
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
          : await this.fetchFor(session, checked, bounded, budget);
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
  ): Promise<string> {
    const target = await this.pin(host, deadline);
    const policy = (at: number, timeout: number) =>
      abortable(
        cached(session.socketPolicies, `${target.address}|${at}`, () =>
          this.socketPolicy(target.address, at, timeout, session.abort.signal),
        ),
        deadline,
      );
    const master = await policy(this.socketPolicyPort, this.limits.masterSocketTimeout);
    if (allowsSocket(master, [], origin.requester, port)) {
      return target.address;
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
          return target.address;
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

    return { url: target.href, target, method, headers, body, purpose };
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

    return { address, rank: RANK[place] };
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

      const response = await this.send(url, target.address, "GET", [], null, signal, {
        read: true,
        max: this.limits.response,
        referer: null,
        budget,
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
  ): Promise<NetResponse> {
    let requester: Requester;
    let rank: number;
    let origin: string | null;
    if (session.movie.kind === "local") {
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
    for (let hop = 0; hop <= this.limits.redirects; hop++) {
      checkPort(url);
      const target = await this.pin(url.hostname, signal);
      const same = origin === url.origin;
      const morePrivate = target.rank > rank;
      const custom = headers.map(([n]) => n).filter((n) => n.toLowerCase() !== "content-type");
      const needsAccess = morePrivate || (!same && request.purpose === "data");
      const needsHeaders = !same && custom.length > 0;
      if (needsAccess || needsHeaders) {
        const policies = await abortable(this.policiesFor(session, url, target.address), signal);
        if (needsAccess && !allowsAccess(policies, requester, url)) {
          throw new Refused(
            morePrivate
              ? `${url.host} is at ${target.address}, more private than the SWF, ` +
                  `and no policy file there grants ${describe(requester)}`
              : `no policy file on ${url.origin} grants ${describe(requester)}`,
          );
        }

        if (needsHeaders && !allowsHeaders(policies, requester, url, custom)) {
          throw new Refused(`no policy file on ${url.origin} lets it send ${custom.join(", ")}`);
        }
      }

      const response = await this.send(url, target.address, method, headers, body, signal, {
        // sendToURL's answer is no one's to read.
        read: request.purpose !== "send",
        max: this.limits.response,
        budget,
        referer: refererFor(session.origin?.url ?? null, url),
      });
      const next = redirectOf(url, response);
      if (!next) {
        return { ...response, ...(url.href === request.url ? {} : { url: url.href }) };
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
        this.urlPolicy(policyUrl, address, session.abort.signal),
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
  ): Promise<UrlPolicy | null> {
    let response: NetResponse;
    try {
      response = await this.send(url, address, "GET", [], null, signal, {
        read: true,
        max: this.limits.policy,
        referer: null,
        timeout: this.limits.policyTimeout,
        deadline: this.limits.policyTimeout,
      });
    } catch {
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

    const policy = parsePolicy(new TextDecoder().decode(response.bytes));
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
    return new Promise((answer) => {
      const chunks: Buffer[] = [];
      let length = 0;
      const socket = connect({ host: address, port });
      const finish = (policy: SocketPolicy | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        socket.destroy();
        answer(policy);
      };
      const read = () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const policy = parsePolicy(text.split("\0")[0]);
        finish(policy && { policy, port });
      };
      const abort = () => finish(null);
      const timer = setTimeout(abort, timeout);
      signal.addEventListener("abort", abort, { once: true });
      socket.on("connect", () => socket.write("<policy-file-request/>\0"));
      socket.on("data", (chunk: Buffer) => {
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
      socket.on("end", read);
      socket.on("error", () => finish(null));
    });
  }

  /**
   * One HTTP exchange with `address`, the URL's host pinned to it: its
   * status and headers, and its body if `read` and the status is a
   * success, up to `max` bytes. No cookies, no credentials, no
   * compression asked for, no connection kept.
   */
  private send(
    url: URL,
    address: string,
    method: string,
    headers: [string, string][],
    body: Uint8Array | null,
    signal: AbortSignal,
    options: {
      read: boolean;
      max: number;
      referer: string | null;
      timeout?: number;
      deadline?: number;
      /** Where the bytes read count against the movie's `buffered`; a policy file's do not. */
      budget?: Budget;
    },
  ): Promise<NetResponse> {
    const timeout = options.timeout ?? this.limits.timeout;
    const deadline = options.deadline ?? this.limits.deadline;
    return new Promise((answer, fail) => {
      if (signal.aborted) {
        fail(new Refused("aborted"));
        return;
      }

      const host = bare(url.hostname);
      const outgoing: Record<string, string> = {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        "x-flash-version": FLASH_VERSION,
      };
      if (options.referer) {
        outgoing.Referer = options.referer;
      }

      for (const [name, value] of headers) {
        outgoing[name] = value;
      }

      if (body) {
        outgoing["Content-Length"] = String(body.length);
      }

      const https = url.protocol === "https:";
      const family = isIP(address);
      let request: ClientRequest;
      try {
        request = (https ? httpsRequest : httpRequest)({
          host,
          port: url.port || (https ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers: outgoing,
          agent: false,
          // The address pinned for this request, whatever the resolver would say now.
          lookup: (_name, opts, callback) => {
            if ((opts as { all?: boolean }).all) {
              (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
                { address, family },
              ]);
            } else {
              (callback as (e: null, a: string, f: number) => void)(null, address, family);
            }
          },
          ...(https ? { servername: isIP(host) ? undefined : host, ca: this.ca } : {}),
        });
      } catch (error) {
        // What check() let through and Node still refuses: a refusal like any other.
        fail(new Refused((error as Error).message));
        return;
      }
      let timer: NodeJS.Timeout;
      const overall = setTimeout(() => stop(new Refused("it took too long")), deadline);
      let finished = false;
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
      request.on("error", (error) => stop(new Refused(error.message)));
      request.on("response", (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const received: [string, string][] = [];
        const raw = response.rawHeaders;
        for (let i = 0; i + 1 < raw.length; i += 2) {
          // The SWF has no cookie jar to keep them in.
          if (!/^set-cookie2?$/i.test(raw[i])) {
            received.push([raw[i], raw[i + 1]]);
          }
        }

        const ok = status >= 200 && status < 300;
        const end = (bytes: Uint8Array | null) => {
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            clearTimeout(overall);
            signal.removeEventListener("abort", abort);
            request.destroy();
            answer({ bytes, status, headers: received });
          }
        };
        if (!ok || !options.read) {
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

        // The body, copied as it comes into one array that doubles as it
        // fills: never a list of the chunks, which for a body sent a byte at
        // a time would hold hundreds of times its size. It starts at the
        // declared length, where that is believable, and so needs no copy at
        // the end.
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
        };
        // Bytes of their own, not a view of a larger array, whose rest IPC
        // would carry to the page with them; the larger array let go of at
        // once, so that it may be collected before IPC copies the rest.
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
      });
      request.end(body ?? undefined);
    });
  }
}

/** What a server may send compressed, unasked, that is decompressed; any other goes as it came. */
const DECODED = new Set(["gzip", "x-gzip", "br", "deflate"]);

/** The longest gzip header read, its name and comment included. */
export const GZIP_HEADER_MAX = 64 * 1024;

/**
 * A gzip header read as its bytes come: kept in an array that doubles as
 * it fills, and parsed on from where the last chunk left off, so that a
 * header sent a byte at a time costs no more than one sent whole. One
 * whose end lies past GZIP_HEADER_MAX is refused, however it is chunked.
 */
export class GzipHeader {
  private bytes = new Uint8Array(64);
  private length = 0;
  /** Where parsing goes on from, and in which part: fixed bytes, extra, name, comment, CRC. */
  private at = 0;
  private part = 0;

  /** What came so far. */
  get buffered(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }

  /** Add `chunk`: the header's length once whole, 0 while more is needed, -1 if it is none. */
  add(chunk: Uint8Array): number {
    if (this.length + chunk.length > this.bytes.length) {
      let capacity = this.bytes.length * 2;
      while (capacity < this.length + chunk.length) {
        capacity *= 2;
      }

      const grown = new Uint8Array(capacity);
      grown.set(this.buffered);
      this.bytes = grown;
    }

    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
    const end = this.parse();
    return end > GZIP_HEADER_MAX || (end === 0 && this.at > GZIP_HEADER_MAX) ? -1 : end;
  }

  private parse(): number {
    const bytes = this.buffered;
    const flags = bytes[3];
    for (;;) {
      switch (this.part) {
        case 0: {
          const magic = [0x1f, 0x8b, 8];
          for (let i = 0; i < Math.min(3, bytes.length); i++) {
            if (bytes[i] !== magic[i]) {
              return -1;
            }
          }

          if (bytes.length < 10) {
            return 0;
          }

          this.at = 10;
          this.part = 1;
          break;
        }
        case 1:
          if (flags & 4) {
            if (bytes.length < this.at + 2) {
              return 0;
            }

            this.at += 2 + (bytes[this.at] | (bytes[this.at + 1] << 8));
          }

          this.part = 2;
          break;
        case 2:
        case 3: {
          // FNAME, then FCOMMENT: each up to its NUL, sought only in what is new.
          if (flags & (this.part === 2 ? 8 : 16)) {
            if (this.at > bytes.length) {
              return 0;
            }

            const nul = bytes.indexOf(0, this.at);
            if (nul < 0) {
              this.at = bytes.length;
              return 0;
            }

            this.at = nul + 1;
          }

          this.part++;
          break;
        }
        default:
          return bytes.length >= this.at + (flags & 2 ? 2 : 0) ? this.at + (flags & 2 ? 2 : 0) : 0;
      }
    }
  }
}

/**
 * Decompresses one body of gzip, deflate or br, choosing its inflater
 * once its first bytes are in: gzip's header is read here and its deflate
 * stream inflated raw, so that what follows the stream (its footer, and
 * whatever a server put after it) is ignored, as Chromium ignores it;
 * deflate is zlib's stream or a raw one, as its first two bytes tell.
 */
class Decompressor {
  /** The first bytes, while they do not yet tell deflate's kind (no more than two). */
  private head = new Uint8Array(0);
  private gzip: GzipHeader | null = null;
  private inflater: Transform | null = null;
  /** Called once the inflater wants more after a write said to wait. */
  onDrain: () => void = () => {};

  private readonly coding: string;
  private readonly data: (chunk: Buffer) => void;
  private readonly done: () => void;
  private readonly failed: () => void;

  constructor(coding: string, data: (chunk: Buffer) => void, done: () => void, failed: () => void) {
    this.coding = coding;
    this.data = data;
    this.done = done;
    this.failed = failed;
  }

  /** Whether more may be written now. */
  write(chunk: Buffer): boolean {
    if (this.inflater) {
      return this.inflater.write(chunk);
    }

    if (this.coding !== "br" && this.coding !== "deflate") {
      this.gzip ??= new GzipHeader();
      const end = this.gzip.add(chunk);
      if (end === 0) {
        return true;
      }

      if (end < 0) {
        this.failed();
        return false;
      }

      return this.start(createInflateRaw(), this.gzip.buffered.subarray(end));
    }

    const head = new Uint8Array(this.head.length + chunk.length);
    head.set(this.head);
    head.set(chunk, this.head.length);
    this.head = head;
    return this.choose(false);
  }

  end(): void {
    if (!this.inflater && this.gzip) {
      // A gzip header that never ended.
      this.failed();
      return;
    }

    if (!this.inflater && !this.choose(true)) {
      return;
    }

    if (this.inflater) {
      this.inflater.end();
    } else {
      // Nothing came: nothing to undo.
      this.done();
    }
  }

  destroy(): void {
    this.inflater?.destroy();
  }

  /** Make the inflater once the bytes so far tell which (`last`: no more come); false: failed. */
  private choose(last: boolean): boolean {
    const head = this.head;
    if (head.length === 0) {
      return true;
    }

    if (this.coding === "br") {
      return this.start(createBrotliDecompress(), head);
    }

    // Deflate: zlib's stream or a raw one, as its first two bytes tell.
    if (head.length < 2 && !last) {
      return true;
    }

    const zlib =
      head.length >= 2 && (head[0] & 0x0f) === 8 && ((head[0] << 8) | head[1]) % 31 === 0;
    return this.start(zlib ? createInflate() : createInflateRaw(), head);
  }

  /** Inflate with `inflater` from `first` on. */
  private start(inflater: Transform, first: Uint8Array): boolean {
    this.inflater = inflater;
    this.head = new Uint8Array(0);
    this.gzip = null;
    inflater.on("data", this.data);
    inflater.on("end", this.done);
    inflater.on("error", this.failed);
    inflater.on("drain", () => this.onDrain());
    return first.length === 0 || inflater.write(first);
  }
}

/**
 * Whether `url` is potentially trustworthy, as the Secure Contexts
 * specification has it for a Referer: https, or this machine by its
 * loopback address or a name under localhost.
 */
function trustworthy(url: URL): boolean {
  if (url.protocol === "https:") {
    return true;
  }

  // A name with its root's dot is the same name; of IPv6 addresses the
  // specification names ::1 alone, not an IPv4 loopback address inside one.
  const host = bare(url.hostname).toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    (isIPv4(host) && addressClass(host) === "loopback")
  );
}

/** The longest Referer sent whole, as the Referrer Policy specification has it. */
const MAX_REFERER = 4096;

/**
 * The Referer a request from the SWF at `swf` to `target` carries, as
 * browsers' strict-origin-when-cross-origin has it: the SWF's URL to its
 * own origin, its origin alone to another, and nothing from https to what
 * is not potentially trustworthy; a URL longer than 4096 characters goes
 * as its origin.
 */
export function refererFor(swf: URL | null, target: URL): string | null {
  if (!swf || (swf.protocol === "https:" && !trustworthy(target))) {
    return null;
  }

  const origin = `${swf.origin}/`;
  if (swf.origin !== target.origin || swf.href.length > MAX_REFERER) {
    return origin.length > MAX_REFERER ? null : origin;
  }

  return swf.href;
}

/** `promise`, or a Refused once `signal` aborts: a request stops waiting on a shared policy. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Refused("aborted"));
  }

  return new Promise((resolve, reject) => {
    const stop = () => reject(new Refused("aborted"));
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/** A host name without an IPv6 address's brackets. */
function bare(host: string): string {
  return host.replace(/^\[(.*)\]$/, "$1");
}

function checkPort(url: URL): void {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (badPort(port)) {
    throw new Refused(`port ${port} is not for HTTP`);
  }
}

/** Where a redirect goes, if `response` is one, to http or https; one elsewhere is refused. */
function redirectOf(url: URL, response: NetResponse): URL | null {
  if (!REDIRECTS.has(response.status)) {
    return null;
  }

  const location = response.headers.find(([n]) => n.toLowerCase() === "location")?.[1];
  if (location === undefined) {
    return null;
  }

  let next: URL;
  try {
    next = new URL(location, url);
  } catch {
    throw new Refused("a redirect to no URL");
  }

  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new Refused(`a redirect to ${next.protocol}`);
  }

  if (next.username || next.password) {
    throw new Refused("a redirect to a URL with credentials");
  }

  next.hash = "";
  return next;
}

/** `key`'s value in `cache`, made once with `make`; a cache grown past its bound starts again. */
function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  make: () => Promise<T>,
): Promise<T> {
  let value = cache.get(key);
  if (!value) {
    if (cache.size >= 512) {
      cache.clear();
    }

    value = make();
    cache.set(key, value);
  }

  return value;
}

function describe(requester: Requester): string {
  return requester.host === null ? 'a local SWF (domain="*")' : requester.host;
}
