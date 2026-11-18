// The command line's switches for this run alone, and what they make:
// --trace and the network's logs, --ignore-certificate-errors,
// --ignore-policy-files and --proxy, the network judged through them and
// what opens an AIR application's WebSockets, each said on stderr as the
// app starts; --no-http-cache;
// --flashvars and --param, the SWF's embedding (embedding.ts); and --software-gl.
import { embeddingArguments } from "./embedding.ts";
import { Network } from "./network.ts";
import { policyIgnoredHosts, policyIgnoredNotice, unverifiedHosts } from "./network-rules.ts";
import { describeProxy, proxyArgument } from "./proxy.ts";
import type { WebSocketOptions } from "./websocket-connections.ts";

/** The app's own arguments: not an AIR application's, after "--". */
const own = process.argv.includes("--")
  ? process.argv.slice(0, process.argv.indexOf("--"))
  : process.argv;
/**
 * --no-http-cache: nothing read from the HTTP cache nor kept in it, nor the
 * cache opened, for this run, whatever the File menu says.
 */
export const httpCacheOff = own.includes("--no-http-cache");
/** --flashvars and --param: what the SWF the command line names is given, as a page's tag gave it. */
export const embedding = embeddingArguments(process.argv);
for (const warning of embedding.warnings) {
  process.stderr.write(`swf2es: ${warning}\n`);
}

/** --software-gl: SwiftShader draws, on the CPU, where Chromium takes no GPU or even where it does (gpu.ts). */
export const softwareGl = own.includes("--software-gl");
/** --trace: what the page logs, a SWF's trace() among it, goes to the terminal. */
export const trace = process.argv.includes("--trace");
// Each request and socket of the SWF's said on stderr: the page's DevTools show none of them.
// --log-sockets says what each socket sends and receives as well, and so the rest too.
export const logSockets = process.argv.includes("--log-sockets");
const logNetwork = logSockets || process.argv.includes("--log-network");
export const netLog = logNetwork ? (line: string) => process.stderr.write(`${line}\n`) : null;
/** The SWF's http and https requests, judged as Flash's sandboxes had them. */
/**
 * --ignore-certificate-errors[=host,...]: HTTPS servers whose certificates go
 * unchecked, for one's own with a certificate it signed itself. For this
 * run alone, never kept, and said aloud: anyone on the way to such a host
 * can read and change what the SWF loads from it.
 */
const unverified = unverifiedHosts(process.argv.slice(1));
if (unverified) {
  process.stderr.write(
    unverified.all
      ? "swf2es: --ignore-certificate-errors: no HTTPS or WSS server's certificate is verified\n"
      : `swf2es: --ignore-certificate-errors: certificates are not verified for ${unverified.hosts.join(", ") || "no host"}\n`,
  );
}

const unverifiedHost = (host: string) =>
  !!unverified && (unverified.all || unverified.hosts.includes(host.toLowerCase()));

/**
 * --ignore-policy-files[=host,...]: hosts whose cross-domain policy files
 * are taken to grant the SWF whatever one could, for a user who chooses to
 * let it read their data: with the switch alone, every host at a public
 * address; named, those, wherever they are. For this run alone, never
 * kept, and said aloud: the SWF reads what this machine reaches of them.
 */
export const ignorePolicy = policyIgnoredHosts(process.argv.slice(1));
if (ignorePolicy) {
  process.stderr.write(`${policyIgnoredNotice(ignorePolicy)}\n`);
}

/**
 * --proxy=<url>: what the SWF's requests, sockets and WebSockets go
 * through. For this run alone, never kept, and said aloud, without its
 * credentials. One that does not parse stops the app rather than letting
 * it run without.
 */
export const proxied = proxyArgument(process.argv.slice(1));
if (proxied && "error" in proxied) {
  process.stderr.write(`swf2es: ${proxied.error}\n`);
  process.exit(2);
}

export const proxy = proxied?.proxy ?? null;
if (proxy) {
  process.stderr.write(
    `swf2es: --proxy: the SWF's requests, sockets and WebSockets go through ${describeProxy(proxy)}\n`,
  );
}

/** What --log-network adds to a line of a connection that went through the proxy. */
export const via = proxy ? " via proxy" : "";
export const warn = (message: string) => process.stderr.write(`swf2es: ${message}\n`);
export const network = new Network({ unverified: unverifiedHost, ignorePolicy, proxy });
/**
 * How an AIR application's WebSockets connect: through the proxy where
 * there is one, a wss: server's certificate unchecked where
 * --ignore-certificate-errors names its host.
 */
export const webSocketOptions: WebSocketOptions = { proxy, unverified: unverifiedHost, warn };
