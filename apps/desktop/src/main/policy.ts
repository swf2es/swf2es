// Flash's cross-domain policy files, as Adobe's Cross Domain Policy File
// Specification (version 2.0, 2010) defines them and Flash Player 10 and
// later applied them: the parser, and what a set of policy files grants a
// requesting SWF. A URL policy file grants reading a site's data and
// sending it headers; a socket policy file grants connecting to ports.
// Pure, without Electron, so that node tests it (tests/desktop/policy.test.ts).

export type MetaPolicy = "none" | "master-only" | "by-content-type" | "by-ftp-filename" | "all";

const META_POLICIES = new Set<string>([
  "none",
  "master-only",
  "by-content-type",
  "by-ftp-filename",
  "all",
]);

/** A port, or an inclusive range of them. */
type Ports = readonly (readonly [from: number, to: number])[];

export interface AccessRule {
  domain: string;
  /** The attribute as written; null where left out, its default then the file kind's. */
  secure: boolean | null;
  /** to-ports, for a socket policy; null where it was left out or does not parse. */
  ports: Ports | null;
}

export interface HeaderRule {
  domain: string;
  /** Lower case: a name, a prefix ending in "*", or "*". */
  headers: readonly string[];
  secure: boolean | null;
}

export interface Policy {
  /** site-control's permitted-cross-domain-policies; null where there is none. */
  siteControl: MetaPolicy | null;
  access: readonly AccessRule[];
  headers: readonly HeaderRule[];
}

/** Who asks: a remote SWF by its URL's host and scheme; a local one has neither. */
export interface Requester {
  /** Lower case, an IPv6 address without its brackets; null for a local SWF. */
  host: string | null;
  /** "http" or "https"; null for a local SWF. */
  scheme: string | null;
}

/** A URL policy file as it came: whence, its Content-Type and X-Permitted-Cross-Domain-Policies. */
export interface UrlPolicy {
  policy: Policy;
  url: URL;
  /** The media type alone, lower case. */
  contentType: string;
  /** X-Permitted-Cross-Domain-Policies' values, lower case. */
  permitted: readonly string[];
}

/** A socket policy file and the port it was served from. */
export interface SocketPolicy {
  policy: Policy;
  port: number;
}

const NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;
const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/;

function decodeEntities(text: string): string | null {
  let failed = false;
  const decoded = text.replace(/&([^;&\s]*);?/g, (whole, name: string) => {
    if (!whole.endsWith(";")) {
      failed = true;
      return whole;
    }

    switch (name) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }

    const code = /^#x([0-9a-f]{1,6})$/i.exec(name)
      ? Number.parseInt(name.slice(2), 16)
      : /^#([0-9]{1,7})$/.exec(name)
        ? Number.parseInt(name.slice(1), 10)
        : -1;
    if (code < 0 || code > 0x10ffff) {
      failed = true;
      return whole;
    }

    return String.fromCodePoint(code);
  });
  return failed ? null : decoded;
}

interface Element {
  name: string;
  attributes: Map<string, string>;
}

/**
 * The root's children, each with its attributes, if `text` is a
 * well-formed document whose root is <cross-domain-policy>; null
 * otherwise. A DOCTYPE is skipped, never read, so no entity of its own
 * is expanded. What the children hold is checked for form and ignored.
 */
function rootChildren(text: string): Element[] | null {
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open: string[] = [];
  const children: Element[] = [];
  let rooted = false;

  const skipPast = (end: string): boolean => {
    const found = text.indexOf(end, at);
    if (found < 0) {
      return false;
    }

    at = found + end.length;
    return true;
  };

  while (at < text.length) {
    const lt = text.indexOf("<", at);
    const between = text.slice(at, lt < 0 ? text.length : lt);
    // Text only inside the root; and none of it read.
    if (open.length === 0 && between.trim() !== "") {
      return null;
    }

    if (lt < 0) {
      break;
    }

    at = lt;
    if (text.startsWith("<?", at)) {
      if (!skipPast("?>")) {
        return null;
      }
    } else if (text.startsWith("<!--", at)) {
      if (!skipPast("-->")) {
        return null;
      }
    } else if (text.startsWith("<![CDATA[", at)) {
      if (open.length === 0 || !skipPast("]]>")) {
        return null;
      }
    } else if (text.startsWith("<!DOCTYPE", at)) {
      if (rooted) {
        return null;
      }

      // To its '>', past an internal subset in brackets.
      const subset = text.indexOf("[", at);
      const close = text.indexOf(">", at);
      if (close < 0) {
        return null;
      }

      if (subset >= 0 && subset < close) {
        at = subset;
        if (!skipPast("]") || !/^\s*>/.test(text.slice(at))) {
          return null;
        }

        at = text.indexOf(">", at) + 1;
      } else {
        at = close + 1;
      }
    } else if (text.startsWith("</", at)) {
      const name = NAME.exec(text.slice(at + 2))?.[0];
      if (!name || open.pop() !== name) {
        return null;
      }

      at += 2 + name.length;
      const end = /^\s*>/.exec(text.slice(at));
      if (!end) {
        return null;
      }

      at += end[0].length;
    } else {
      const name = NAME.exec(text.slice(at + 1))?.[0];
      if (!name) {
        return null;
      }

      at += 1 + name.length;
      const attributes = new Map<string, string>();
      for (;;) {
        const attribute = ATTRIBUTE.exec(text.slice(at));
        if (!attribute) {
          break;
        }

        const value = decodeEntities(attribute[2] ?? attribute[3]);
        if (value === null || attributes.has(attribute[1])) {
          return null;
        }

        attributes.set(attribute[1], value);
        at += attribute[0].length;
      }

      const end = /^\s*(\/?)>/.exec(text.slice(at));
      if (!end) {
        return null;
      }

      at += end[0].length;
      const empty = end[1] === "/";
      if (open.length === 0) {
        if (rooted || name !== "cross-domain-policy") {
          return null;
        }

        rooted = true;
      } else if (open.length === 1) {
        children.push({ name, attributes });
      }

      if (!empty) {
        open.push(name);
      }
    }
  }

  return rooted && open.length === 0 ? children : null;
}

/** to-ports: "*", or ports and ranges separated by commas; null if any part is not one. */
export function parsePorts(text: string): Ports | null {
  if (text.trim() === "*") {
    return [[1, 65535]];
  }

  const ports: [number, number][] = [];
  for (const part of text.split(",")) {
    const range = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(part);
    if (!range) {
      return null;
    }

    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from < 1 || to > 65535 || from > to) {
      return null;
    }

    ports.push([from, to]);
  }

  return ports;
}

function secureOf(value: string | undefined): boolean | null {
  switch (value?.trim().toLowerCase()) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      return null;
  }
}

/**
 * The policy in `text`, or null where it is not one: not well-formed, or
 * its root not <cross-domain-policy>. A socket server ends its answer with
 * a NUL, which is not part of it. Rules without a domain are dropped.
 */
export function parsePolicy(text: string): Policy | null {
  const children = rootChildren(text.replace(/\0+$/, ""));
  if (!children) {
    return null;
  }

  let siteControl: MetaPolicy | null = null;
  const access: AccessRule[] = [];
  const headers: HeaderRule[] = [];
  for (const { name, attributes } of children) {
    const domain = attributes.get("domain")?.trim();
    switch (name) {
      case "site-control": {
        const value = attributes.get("permitted-cross-domain-policies")?.trim().toLowerCase();
        // An unknown value permits nothing more than none would.
        siteControl = value && META_POLICIES.has(value) ? (value as MetaPolicy) : "none";
        break;
      }
      case "allow-access-from": {
        if (domain) {
          const toPorts = attributes.get("to-ports");
          access.push({
            domain,
            secure: secureOf(attributes.get("secure")),
            ports: toPorts === undefined ? null : parsePorts(toPorts),
          });
        }

        break;
      }
      case "allow-http-request-headers-from": {
        const names = attributes.get("headers");
        if (domain && names !== undefined) {
          headers.push({
            domain,
            headers: names
              .split(",")
              .map((h) => h.trim().toLowerCase())
              .filter((h) => h !== ""),
            secure: secureOf(attributes.get("secure")),
          });
        }

        break;
      }
    }
  }

  return { siteControl, access, headers };
}

/**
 * Whether a domain attribute names `requester`, by the specification's
 * matching rules: "*" is everyone, local SWFs among them, which nothing
 * else names; a name or an IP address is itself exactly, an address
 * never its host's name; "*.example.com" is example.com and every name
 * under it, and a wildcard anywhere else matches nothing. "http://" or
 * "https://" before the domain also asks for that scheme.
 */
export function domainMatches(pattern: string, requester: Requester): boolean {
  let domain = pattern.trim().toLowerCase();
  if (domain === "*") {
    return true;
  }

  if (requester.host === null) {
    return false;
  }

  const scheme = /^(https?):\/\//.exec(domain);
  if (scheme) {
    if (scheme[1] !== requester.scheme) {
      return false;
    }

    domain = domain.slice(scheme[0].length);
  }

  domain = domain.replace(/^\[(.*)\]$/, "$1");
  if (domain.startsWith("*.")) {
    const suffix = domain.slice(2);
    // A second-level domain at least, and no address.
    if (!suffix.includes(".") || suffix.includes("*") || /^[\d.]+$/.test(suffix)) {
      return false;
    }

    return requester.host === suffix || requester.host.endsWith(`.${suffix}`);
  }

  return !domain.includes("*") && domain !== "" && requester.host === domain;
}

/**
 * Whether an HTTPS policy's rule reaches `requester`: secure, its default,
 * grants only a SWF itself loaded over HTTPS, as the specification has it;
 * a local SWF, which no HTTPS brought, is not one. An HTTP policy's rules
 * reach any.
 */
function secureAllows(policyHttps: boolean, secure: boolean | null, requester: Requester): boolean {
  return !policyHttps || secure === false || requester.scheme === "https";
}

/** The meta-policy restrictiveness order: a lower rank permits less. */
const RANK: Record<MetaPolicy, number> = {
  none: 0,
  "master-only": 1,
  "by-ftp-filename": 1,
  "by-content-type": 2,
  all: 3,
};

/**
 * The site's meta-policy, from its master policy file: the stricter of
 * its site-control and the X-Permitted-Cross-Domain-Policies it came with,
 * else Flash Player 10's default, master-only. by-ftp-filename is FTP's
 * and permits no other file over HTTP. A site with no master policy file
 * has the default.
 */
export function urlMetaPolicy(master: UrlPolicy | null): MetaPolicy {
  if (!master) {
    return "master-only";
  }

  const given: MetaPolicy[] = [];
  if (master.policy.siteControl) {
    given.push(master.policy.siteControl);
  }

  for (const value of master.permitted) {
    given.push(META_POLICIES.has(value) ? (value as MetaPolicy) : "none");
  }

  if (given.length === 0) {
    return "master-only";
  }

  return given.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

/** The Content-Types a URL policy file may come with, as the specification lists them. */
export function policyContentType(type: string): boolean {
  return type.startsWith("text/") || type === "application/xml" || type === "application/xhtml+xml";
}

/**
 * The policy files of a site that count, by its meta-policy: none for
 * "none", the master alone for master-only, and the others too for "all",
 * or for by-content-type those served as text/x-cross-domain-policy.
 * A file whose X-Permitted-Cross-Domain-Policies says none-this-response
 * is no policy file at all; the caller has dropped it.
 */
export function usablePolicies(
  master: UrlPolicy | null,
  others: readonly UrlPolicy[],
): UrlPolicy[] {
  const meta = urlMetaPolicy(master);
  if (meta === "none") {
    return [];
  }

  const usable = master ? [master] : [];
  for (const other of others) {
    if (
      meta === "all" ||
      (meta === "by-content-type" && other.contentType === "text/x-cross-domain-policy")
    ) {
      usable.push(other);
    }
  }

  return usable;
}

/**
 * Whether `policy` covers `target`: a master policy file its whole site,
 * any other its own directory and below. The caller has checked that both
 * are of one origin.
 */
function covers(policy: UrlPolicy, target: URL): boolean {
  const directory = policy.url.pathname.slice(0, policy.url.pathname.lastIndexOf("/") + 1);
  return target.pathname.startsWith(directory);
}

/** Whether the usable `policies` of `target`'s site let `requester` read `target`. */
export function allowsAccess(
  policies: readonly UrlPolicy[],
  requester: Requester,
  target: URL,
): boolean {
  return policies.some(
    (p) =>
      p.url.origin === target.origin &&
      covers(p, target) &&
      p.policy.access.some(
        (rule) =>
          domainMatches(rule.domain, requester) &&
          secureAllows(p.url.protocol === "https:", rule.secure, requester),
      ),
  );
}

function headerAllowed(allowed: readonly string[], name: string): boolean {
  return allowed.some((h) => (h.endsWith("*") ? name.startsWith(h.slice(0, -1)) : h === name));
}

/** Whether the usable `policies` of `target`'s site let `requester` send it each of `names`. */
export function allowsHeaders(
  policies: readonly UrlPolicy[],
  requester: Requester,
  target: URL,
  names: readonly string[],
): boolean {
  const rules = policies
    .filter((p) => p.url.origin === target.origin && covers(p, target))
    .flatMap((p) =>
      p.policy.headers.filter(
        (rule) =>
          domainMatches(rule.domain, requester) &&
          secureAllows(p.url.protocol === "https:", rule.secure, requester),
      ),
    );
  return names.every((name) =>
    rules.some((rule) => headerAllowed(rule.headers, name.toLowerCase())),
  );
}

/**
 * A socket server's meta-policy, from the policy on its port 843: its
 * site-control, by default "all", so that a policy on any port counts.
 * by-content-type and by-ftp-filename are HTTP's and FTP's, and permit no
 * other socket policy.
 */
export function socketMetaPolicy(master: SocketPolicy | null): MetaPolicy {
  const meta = master?.policy.siteControl ?? "all";
  return meta === "by-content-type" || meta === "by-ftp-filename" ? "master-only" : meta;
}

/**
 * Whether one socket policy lets `requester` connect to `port`: a rule
 * naming it whose to-ports holds the port, where a policy served from a
 * port of 1024 or above grants only ports of 1024 and above, as Flash
 * Player had it, since any user may serve one there. secure is false by
 * default in a socket policy; true grants only a SWF loaded over HTTPS.
 */
function socketGrants(policy: SocketPolicy, requester: Requester, port: number): boolean {
  if (policy.port >= 1024 && port < 1024) {
    return false;
  }

  return policy.policy.access.some(
    (rule) =>
      rule.ports?.some(([from, to]) => port >= from && port <= to) === true &&
      domainMatches(rule.domain, requester) &&
      (rule.secure !== true || requester.scheme === "https"),
  );
}

/**
 * Whether a socket server's policies let `requester` connect to `port`:
 * its master policy, the one on port 843, and, as its meta-policy allows,
 * those on other ports (the one on `port` itself, and those
 * Security.loadPolicyFile named).
 */
export function allowsSocket(
  master: SocketPolicy | null,
  others: readonly SocketPolicy[],
  requester: Requester,
  port: number,
): boolean {
  const meta = socketMetaPolicy(master);
  if (meta === "none") {
    return false;
  }

  if (master && socketGrants(master, requester, port)) {
    return true;
  }

  return meta === "all" && others.some((p) => socketGrants(p, requester, port));
}

/**
 * The request headers Flash Player refused a SWF outside AIR's application
 * sandbox (URLRequestHeader), lower case, with "_" read as "-" as Flash
 * read it.
 */
const FORBIDDEN_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "accept-ranges",
  "age",
  "allow",
  "allowed",
  "authorization",
  "charge-to",
  "connect",
  "connection",
  "content-length",
  "content-location",
  "content-range",
  "cookie",
  "date",
  "delete",
  "etag",
  "expect",
  "get",
  "head",
  "host",
  "if-modified-since",
  "keep-alive",
  "last-modified",
  "location",
  "max-forwards",
  "options",
  "origin",
  "post",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "public",
  "put",
  "range",
  "referer",
  "request-range",
  "retry-after",
  "server",
  "te",
  "trace",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "uri",
  "user-agent",
  "vary",
  "via",
  "warning",
  "www-authenticate",
  "x-flash-version",
]);

/**
 * Whether a SWF may not send a header of this name: Flash's list, and
 * what a browser forbids a page beside it (Proxy- and Sec- headers).
 */
export function forbiddenHeader(name: string): boolean {
  const lower = name.toLowerCase().replaceAll("_", "-");
  return FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-");
}
