// What network.ts's requests are and what bounds them: the request and
// response a SWF's fetch carries, the movie they are judged for, the
// limits, and the state one movie's requests share.
import type { AddressClass } from "./addresses.ts";
import type { Requester, SocketPolicy, UrlPolicy } from "./policy.ts";
import type { ProxyConfig } from "./proxy.ts";

export type Purpose = "movie" | "content" | "data" | "send";

export interface NetRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
  purpose: Purpose;
  /**
   * Whether the body of a response whose status is 400 or more is read
   * too, which an AIR application's URLLoader and URLStream complete
   * with; only an application is given it.
   */
  errorBody?: boolean;
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

/**
 * The movie whose requests are judged: a remote SWF by its URL, a local
 * one with networking, or an AIR application, whose sandbox reaches the
 * network unjudged, as AIR's application sandbox does: any address, no
 * policy file.
 */
export type Movie = { kind: "remote"; url: string } | { kind: "local" } | { kind: "application" };

export interface NetworkOptions {
  /** A host name's addresses, in order of preference: the system's resolver by default. */
  resolve?: (host: string) => Promise<string[]>;
  /** Where an address is: addresses.ts's by default; null for one never reached. */
  classify?: (address: string) => AddressClass | null;
  /** The certificate authorities HTTPS trusts, in place of Node's and the system's. */
  ca?: string | string[];
  /**
   * Hosts whose HTTPS certificate is not verified: a server with one it
   * signed itself, as a developer's own has (--ignore-certificate-errors).
   * None by default.
   */
  unverified?: (host: string) => boolean;
  limits?: Partial<Limits>;
  /** Where a socket server keeps its master policy: 843. */
  socketPolicyPort?: number;
  /** What every connection goes through (--proxy); none by default. */
  proxy?: ProxyConfig | null;
}

/** A remote movie once its SWF has come, where from. */
export interface Origin {
  /** Its URL after redirects: its loaderInfo.url, and its Referer. */
  url: URL;
  requester: Requester;
  rank: number;
}

export interface Pinned {
  address: string;
  rank: number;
}

/** What one movie's requests share, and lose as the next opens. */
/** What one request's responses hold of its movie's `buffered`, given back as it is answered. */
export interface Budget {
  session: Session;
  taken: number;
}

export interface Session {
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
