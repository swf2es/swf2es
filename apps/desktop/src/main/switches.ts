// The command line's switches for this run alone, and what they make:
// --trace and the network's logs, --ignore-certificate-errors and --proxy,
// the network judged through them and what opens an AIR application's
// WebSockets. Each said on stderr as the app starts.
import { Network } from "./network.ts";
import { unverifiedHosts } from "./network-rules.ts";
import { describeProxy, proxyArgument } from "./proxy.ts";
import {
  dispatchedOpener,
  type Opener,
  proxiedDispatcher,
  unverifiedDispatcher,
  webSocketOpener,
} from "./websocket-connections.ts";

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
export const network = new Network({ unverified: unverifiedHost, proxy });
// What opens an AIR application's WebSockets: the global's client, a wss: server's certificate
// unchecked where the switch names its host; or every one through the proxy.
const insecureWebSockets = unverified && !proxy ? unverifiedDispatcher() : null;
if (unverified && !proxy && !insecureWebSockets) {
  process.stderr.write(
    "swf2es: --ignore-certificate-errors: a WebSocket's certificate is verified all the same\n",
  );
}

export const proxiedWebSockets = proxy ? proxiedDispatcher(proxy, unverifiedHost, warn) : null;
// Never past the proxy: where none can be made, no WebSocket opens.
export const webSocketOpen: Opener | undefined = proxy
  ? proxiedWebSockets
    ? dispatchedOpener(proxiedWebSockets)
    : () => {
        throw new Error("no WebSocket through the proxy");
      }
  : insecureWebSockets
    ? webSocketOpener(unverifiedHost, insecureWebSockets)
    : undefined;
if (proxy && !proxiedWebSockets) {
  process.stderr.write("swf2es: --proxy: this Electron's WebSocket cannot go through a proxy\n");
}
