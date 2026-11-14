// The rules network.ts applies that need none of its state: Referers,
// redirects, ports, the certificate switch, and the small helpers its
// requests share. Without Electron, as network.ts is.
import { isIPv4 } from "node:net";
import * as tls from "node:tls";
import { addressClass, badPort } from "./addresses.ts";
import { type NetResponse, Refused } from "./network-types.ts";
import type { Requester } from "./policy.ts";
import { ProxyError } from "./proxy.ts";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The system's trusted roots beside Node's, where this Node can tell them. */
export function defaultCa(): string[] | undefined {
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

/**
 * The hosts --ignore-certificate-errors names, of the app's arguments up to
 * an AIR application's own after "--": null without the switch; with it
 * alone, every host; with `=a.test,b.test`, those, whatever their case.
 * A host is a name or an address, with no port: every port of it.
 */
export function unverifiedHosts(argv: string[]): { all: boolean; hosts: string[] } | null {
  const end = argv.indexOf("--");
  const own = end < 0 ? argv : argv.slice(0, end);
  let named = false;
  let all = false;
  const hosts: string[] = [];
  for (const arg of own) {
    if (arg === "--ignore-certificate-errors") {
      named = true;
      all = true;
    } else if (arg.startsWith("--ignore-certificate-errors=")) {
      // The switch with nothing named ignores nothing, rather than everything by a slip.
      named = true;
      for (const host of arg.slice(arg.indexOf("=") + 1).split(",")) {
        if (host.trim() !== "") {
          hosts.push(host.trim().toLowerCase());
        }
      }
    }
  }

  return named ? { all, hosts } : null;
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
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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
export function bare(host: string): string {
  return host.replace(/^\[(.*)\]$/, "$1");
}

export function checkPort(url: URL): void {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (badPort(port)) {
    throw new Refused(`port ${port} is not for HTTP`);
  }
}

/** Where a redirect goes, if `response` is one, to http or https; one elsewhere is refused. */
export function redirectOf(url: URL, response: NetResponse): URL | null {
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
export function cached<T>(
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
    // A failure, a proxy's, is not kept: the next request asks again.
    const made = value;
    made.catch(() => {
      if (cache.get(key) === made) {
        cache.delete(key);
      }
    });
  }

  return value;
}

/** Whether `error` is a refusal for a proxy that failed, not a server it did not reach. */
export function proxyFault(error: unknown): boolean {
  const cause = (error as Error | null)?.cause;
  return cause instanceof ProxyError && cause.fault;
}

export function describe(requester: Requester): string {
  return requester.host === null ? 'a local SWF (domain="*")' : requester.host;
}
