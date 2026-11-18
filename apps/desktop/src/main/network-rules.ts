// The rules network.ts applies that need none of its state: Referers,
// redirects, ports, the certificate and policy switches, and the small
// helpers its requests share. Without Electron, as network.ts is.
import { isIP, isIPv4, isIPv6 } from "node:net";
import * as tls from "node:tls";
import { type AddressClass, addressClass, badPort } from "./addresses.ts";
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

/** The hosts a switch such as --ignore-certificate-errors names: every one, or those listed. */
export interface HostList {
  all: boolean;
  /** As a URL's host has them: lower case, an IPv6 address without its brackets. */
  hosts: string[];
}

/**
 * A host as a URL's hostname has it, for comparing a host named on the
 * command line, or a socket's, with a URL's: lower case, an IPv6 address
 * without its brackets and in its shortest form, an IPv4 address in its
 * dotted decimal form, an international name in its ASCII form. Null for
 * anything but a host alone: a URL's parser would drop a scheme,
 * credentials, a port, a path, a query or a fragment, or decode an escape,
 * that a resolver might take as part of the name, so that a SWF's
 * `listed.example/.elsewhere` would match a listed host and resolve to
 * another.
 */
export function hostOf(text: string): string | null {
  const host = bare(text);
  const v6 = isIPv6(host);
  if (host === "" || /[\s/\\?#@%]/.test(host) || (!v6 && /[:[\]]/.test(host))) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(`http://${v6 ? `[${host}]` : host}/`);
  } catch {
    return null;
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  // An address in another form is that address; an ASCII name differs only by its case.
  const name = bare(parsed.hostname);
  if (!isIP(name) && /^[\x21-\x7e]*$/.test(host) && name !== host.toLowerCase()) {
    return null;
  }

  return name;
}

/**
 * The host a command line's entry names, or null for none, each surprise
 * said through `say`: a wildcard, which matches nothing; a port, which
 * names every port of its host; and a form the host is not written in,
 * an address's other spelling among them.
 */
function listedHost(given: string, say: (message: string) => void): string | null {
  if (given.includes("*")) {
    say(`${given} matches no host: hosts are matched exactly, without wildcards`);
    return null;
  }

  const port = /^(\[[^\]]*\]|[^:]*):(\d{1,5})$/.exec(given);
  const text = port ? port[1] : given;
  const host = hostOf(text);
  if (host === null) {
    say(`${given} is not a host name or address, and is left out`);
    return null;
  }

  if (port) {
    say(`${given} names a port: every port of ${host} is taken`);
  } else if (host !== bare(text).toLowerCase()) {
    say(`${given} is taken as ${host}`);
  }

  return host;
}

/**
 * The hosts the switch `name` names, of the app's arguments up to an AIR
 * application's own after "--": null without the switch; with it alone,
 * every host; with `=a.test,b.test`, those, whatever their case. A host is
 * a name or an address, with no port: every port of it. What an entry
 * does not mean as written is said through `warn`, a line for stderr.
 */
function hostSwitch(argv: string[], name: string, warn: (line: string) => void): HostList | null {
  const end = argv.indexOf("--");
  const own = end < 0 ? argv : argv.slice(0, end);
  const say = (message: string) => warn(`swf2es: ${name}: ${message}`);
  let named = false;
  let all = false;
  const hosts: string[] = [];
  for (const arg of own) {
    if (arg === name) {
      named = true;
      all = true;
    } else if (arg.startsWith(`${name}=`)) {
      // The switch with nothing named ignores nothing, rather than everything by a slip.
      named = true;
      for (const entry of arg.slice(name.length + 1).split(",")) {
        const host = entry.trim() === "" ? null : listedHost(entry.trim(), say);
        if (host !== null) {
          hosts.push(host);
        }
      }
    }
  }

  return named ? { all, hosts } : null;
}

/** The hosts --ignore-certificate-errors names, whose HTTPS certificates go unchecked. */
export function unverifiedHosts(
  argv: string[],
  warn: (line: string) => void = () => {},
): HostList | null {
  return hostSwitch(argv, "--ignore-certificate-errors", warn);
}

/**
 * The hosts --ignore-policy-files names, whose policy files are taken to
 * grant the SWF whatever one could (policyIgnored).
 */
export function policyIgnoredHosts(
  argv: string[],
  warn: (line: string) => void = () => {},
): HostList | null {
  return hostSwitch(argv, "--ignore-policy-files", warn);
}

/**
 * Whether --ignore-policy-files stands in for the policy files of `host`,
 * reached at an address of `place`: a host it names, wherever it is; with
 * the switch alone, every host at a public address, and none on this
 * machine or a private network, whose own policy is still asked where the
 * SWF is less private than it. The one decision for every policy a SWF
 * would ask: a URL policy's access and headers, and a socket policy.
 */
export function policyIgnored(list: HostList | null, host: string, place: AddressClass): boolean {
  if (!list) {
    return false;
  }

  // Never for a host that is not a host alone, by name or as public: it may resolve otherwise.
  const name = hostOf(host);
  return name !== null && (list.hosts.includes(name) || (list.all && place === "public"));
}

/** What the app says on stderr as it starts with --ignore-policy-files. */
export function policyIgnoredNotice(list: HostList): string {
  const named = list.hosts.join(", ");
  return list.all
    ? "swf2es: --ignore-policy-files: every public host" +
        (named ? ` and ${named}` : "") +
        " taken to grant the SWF what a policy file could; an address on this machine" +
        " or a private network still needs its own policy file unless named"
    : `swf2es: --ignore-policy-files: ${named || "no host"} taken to grant the SWF what a` +
        " policy file could; any other host still needs its own policy file";
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
