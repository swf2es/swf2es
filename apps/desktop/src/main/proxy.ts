// --proxy=<url>: a proxy that every connection the main process makes for
// a SWF goes through, its http and https requests, its sockets, its policy
// files and an AIR application's WebSockets: a SOCKS5 proxy (RFC 1928,
// with RFC 1929's username and password where the URL gives them), or an
// HTTP proxy, asked for a CONNECT tunnel for each connection, plain http
// too, with Basic credentials where given. The URL's credentials are the
// command line's alone: never kept, and never said.
//
// Without Electron, so that node tests it (tests/desktop/proxy.test.ts).
import { connect, isIP, isIPv4, type Socket } from "node:net";
import { domainToASCII } from "node:url";

export interface ProxyConfig {
  kind: "socks5" | "http";
  /** Its host, an IPv6 address without its brackets. */
  host: string;
  port: number;
  /** Both or neither: a URL with a username and no password has an empty one. */
  username: string | null;
  password: string | null;
}

/**
 * A connection through the proxy that did not come about. `fault` says
 * whether the proxy itself failed, not reached, refusing the credentials
 * or making no sense, rather than answering that the target was not
 * reached, which is no more than a server that is not there.
 */
export class ProxyError extends Error {
  readonly fault: boolean;

  constructor(message: string, fault: boolean) {
    super(message);
    this.fault = fault;
  }
}

/** How long the proxy may take to connect and answer, all told. */
const TIMEOUT = 30_000;
/** The longest answer an HTTP proxy gives a CONNECT, its headers included. */
const MAX_HEADERS = 16 * 1024;

const SCHEMES: Record<string, ProxyConfig["kind"]> = {
  "socks5:": "socks5",
  // The same: the target's name always goes to the proxy, which resolves it.
  "socks5h:": "socks5",
  "http:": "http",
};
const DEFAULT_PORTS: Record<ProxyConfig["kind"], number> = { socks5: 1080, http: 80 };

/** `text` with whatever could be credentials left out, for a message. */
function redacted(text: string): string {
  return text.includes("@") ? text.replace(/^([a-z][a-z0-9+.-]*:\/\/)?.*@/i, "$1…@") : text;
}

/** `text` as a proxy; a message that never holds its credentials, otherwise. */
export function parseProxy(text: string): ProxyConfig {
  const shown = redacted(text).slice(0, 256);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${shown} is not a URL`);
  }

  const kind = SCHEMES[url.protocol];
  if (!kind) {
    throw new Error(`${url.protocol}// is no proxy this app speaks: socks5:// or http://`);
  }

  // A URL standard's non-special scheme keeps its host as written.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (host === "") {
    throw new Error(`${shown} names no host`);
  }

  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new Error(`${shown} has more than a host and a port`);
  }

  let username: string | null = null;
  let password: string | null = null;
  if (url.username !== "" || url.password !== "") {
    try {
      username = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
    } catch {
      throw new Error(`${shown} has malformed %-escapes in its credentials`);
    }

    if (
      kind === "socks5" &&
      (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255)
    ) {
      throw new Error("a SOCKS5 username or password is 255 bytes at most");
    }

    // Basic's user-id ends at its first colon, and neither has a line break.
    if (kind === "http" && (username.includes(":") || /[\r\n]/.test(username + password))) {
      throw new Error("an HTTP proxy's username has no colon, nor either a line break");
    }
  }

  return {
    kind,
    host,
    port: url.port === "" ? DEFAULT_PORTS[kind] : Number(url.port),
    username,
    password,
  };
}

/** The proxy as a message names it: its kind, host and port, never its credentials. */
export function describeProxy(proxy: ProxyConfig): string {
  const host = isIP(proxy.host) === 6 ? `[${proxy.host}]` : proxy.host;
  return `${proxy.kind}://${host}:${proxy.port}`;
}

/**
 * The proxy --proxy=<url> names among the app's arguments, those before an
 * AIR application's own after "--": null without one; its last if named
 * twice. A malformed one, or --proxy with its URL apart, is an error, not
 * a run without the proxy.
 */
export function proxyArgument(argv: string[]): { proxy: ProxyConfig } | { error: string } | null {
  const end = argv.indexOf("--");
  const own = end < 0 ? argv : argv.slice(0, end);
  let found: { proxy: ProxyConfig } | { error: string } | null = null;
  for (const arg of own) {
    if (arg === "--proxy") {
      return { error: "--proxy takes its URL after an equals sign: --proxy=socks5://host:port" };
    }

    if (arg.startsWith("--proxy=")) {
      try {
        found = { proxy: parseProxy(arg.slice("--proxy=".length)) };
      } catch (error) {
        return { error: `--proxy: ${(error as Error).message}` };
      }
    }
  }

  return found;
}

/** Whether `a` and `b` are the same proxy, by the same credentials. */
export function sameProxy(a: ProxyConfig | null, b: ProxyConfig | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.kind === b.kind &&
      a.host === b.host &&
      a.port === b.port &&
      a.username === b.username &&
      a.password === b.password)
  );
}

/** A target as the proxy is asked for it: an address, or a name in ASCII. */
function targetHost(host: string): { address: string; family: 4 | 6 } | { name: string } {
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(bare);
  if (family === 4 || family === 6) {
    return { address: bare, family };
  }

  // A name of DNS's letters alone: nothing that would end a line of the HTTP proxy's request.
  const name = domainToASCII(bare);
  if (name === "" || name.length > 255 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new ProxyError("its host is no name a proxy is asked for", false);
  }

  return { name };
}

/** An IPv6 address's 16 bytes; `address` is one, as isIP says. */
function ipv6Bytes(address: string): Buffer {
  let text = address.replace(/%.*$/, "");
  // A last part that is an IPv4 address is two of the eight.
  const v4 = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4 && isIPv4(v4[1])) {
    const [a, b, c, d] = v4[1].split(".").map(Number);
    text = `${text.slice(0, v4.index)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, tail] = text.split("::") as [string, string | undefined];
  const parts = (s: string | undefined) => (s ? s.split(":") : []);
  const left = parts(head);
  const right = parts(tail);
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    bytes.writeUInt16BE(Number.parseInt(groups[i], 16), i * 2);
  }

  return bytes;
}

/** Reads a socket's bytes as a handshake needs them, and gives back what it did not need. */
class Reader {
  private buffered = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private ended = false;
  private readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("readable", this.readable);
    socket.on("end", this.end);
  }

  private readonly readable = () => {
    for (let chunk = this.socket.read() as Buffer | null; chunk; chunk = this.socket.read()) {
      this.buffered = Buffer.concat([this.buffered, chunk]);
    }

    this.wake?.();
  };

  private readonly end = () => {
    this.ended = true;
    this.wake?.();
  };

  private async more(): Promise<void> {
    if (this.ended) {
      throw new Error("closed");
    }

    await new Promise<void>((woken) => {
      this.wake = woken;
    });
    this.wake = null;
  }

  async take(length: number): Promise<Buffer> {
    while (this.buffered.length < length) {
      await this.more();
    }

    const bytes = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return bytes;
  }

  /** Up to and with `marker`, failing past `max` bytes. */
  async until(marker: string, max: number): Promise<Buffer> {
    for (;;) {
      const at = this.buffered.indexOf(marker);
      if (at >= 0) {
        return this.take(at + marker.length);
      }

      if (this.buffered.length > max) {
        throw new Error("too long");
      }

      await this.more();
    }
  }

  /** Stop reading; what came past the handshake goes back, for the socket's next reader. */
  release(): void {
    this.socket.removeListener("readable", this.readable);
    this.socket.removeListener("end", this.end);
    if (this.buffered.length > 0) {
      this.socket.unshift(this.buffered);
    }
  }
}

/** RFC 1928's replies, as a message says them. */
const SOCKS_REPLIES: Record<number, string> = {
  1: "general failure",
  2: "not allowed by its rules",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

async function socks5(
  proxy: ProxyConfig,
  socket: Socket,
  reader: Reader,
  target: ReturnType<typeof targetHost>,
  port: number,
): Promise<void> {
  const where = describeProxy(proxy);
  const credentials = proxy.username !== null;
  socket.write(Buffer.from(credentials ? [5, 2, 0, 2] : [5, 1, 0]));
  const [version, method] = await reader.take(2);
  if (version !== 5) {
    throw new ProxyError(`the proxy ${where} gave no SOCKS5 answer`, true);
  }

  if (method === 2 && credentials) {
    const username = Buffer.from(proxy.username ?? "");
    const password = Buffer.from(proxy.password ?? "");
    socket.write(
      Buffer.concat([
        Buffer.from([1, username.length]),
        username,
        Buffer.from([password.length]),
        password,
      ]),
    );
    const [, status] = await reader.take(2);
    if (status !== 0) {
      throw new ProxyError(`the proxy ${where} refused the username and password`, true);
    }
  } else if (method === 0xff) {
    throw new ProxyError(
      credentials
        ? `the proxy ${where} takes none of the ways to authenticate offered`
        : `the proxy ${where} asks for a username and password`,
      true,
    );
  } else if (method !== 0) {
    throw new ProxyError(`the proxy ${where} chose a way to authenticate not offered`, true);
  }

  let address: Buffer;
  if ("name" in target) {
    const name = Buffer.from(target.name, "ascii");
    address = Buffer.concat([Buffer.from([3, name.length]), name]);
  } else if (target.family === 4) {
    address = Buffer.from([1, ...target.address.split(".").map(Number)]);
  } else {
    address = Buffer.concat([Buffer.from([4]), ipv6Bytes(target.address)]);
  }

  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, portBytes]));
  const [replyVersion, reply, , type] = await reader.take(4);
  if (replyVersion !== 5) {
    throw new ProxyError(`the proxy ${where} gave no SOCKS5 answer`, true);
  }

  if (reply !== 0) {
    const why = SOCKS_REPLIES[reply] ?? "an unknown reply";
    throw new ProxyError(`the proxy ${where} refused: ${why} (SOCKS reply ${reply})`, false);
  }

  // The address and port the proxy connected from, which nothing needs.
  switch (type) {
    case 1:
      await reader.take(4 + 2);
      break;
    case 3:
      await reader.take((await reader.take(1))[0] + 2);
      break;
    case 4:
      await reader.take(16 + 2);
      break;
    default:
      throw new ProxyError(`the proxy ${where} gave no SOCKS5 answer`, true);
  }
}

async function httpConnect(
  proxy: ProxyConfig,
  socket: Socket,
  reader: Reader,
  target: ReturnType<typeof targetHost>,
  port: number,
): Promise<void> {
  const where = describeProxy(proxy);
  const host =
    "name" in target ? target.name : target.family === 6 ? `[${target.address}]` : target.address;
  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
  if (proxy.username !== null) {
    const basic = Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64");
    lines.push(`Proxy-Authorization: Basic ${basic}`);
  }

  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  let head: string;
  try {
    head = (await reader.until("\r\n\r\n", MAX_HEADERS)).toString("latin1");
  } catch (error) {
    if ((error as Error).message === "too long") {
      throw new ProxyError(`the proxy ${where} answered with too long a head`, true);
    }

    throw error;
  }

  const status = /^HTTP\/1\.[01] (\d{3})(?: ([^\r\n]*))?\r\n/.exec(head);
  if (!status) {
    throw new ProxyError(`the proxy ${where} gave no HTTP answer`, true);
  }

  const code = Number(status[1]);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is taken out
  const reason = (status[2] ?? "").slice(0, 128).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  if (code === 407) {
    throw new ProxyError(
      proxy.username !== null
        ? `the proxy ${where} refused the username and password (HTTP 407)`
        : `the proxy ${where} asks for a username and password (HTTP 407)`,
      true,
    );
  }

  if (code < 200 || code > 299) {
    throw new ProxyError(`the proxy ${where} refused: HTTP ${code} ${reason}`.trimEnd(), false);
  }
}

/**
 * A TCP connection to `host`:`port` through `proxy`, once the proxy says it
 * is made: a name goes to the proxy as it is, for it to resolve, an
 * address as that address. It fails with a ProxyError saying why, never
 * naming the credentials; `signal` stops it.
 */
export function connectThrough(
  proxy: ProxyConfig,
  host: string,
  port: number,
  options: { signal?: AbortSignal; timeout?: number } = {},
): Promise<Socket> {
  const where = describeProxy(proxy);
  return new Promise((resolve, reject) => {
    let target: ReturnType<typeof targetHost>;
    try {
      target = targetHost(host);
    } catch (error) {
      reject(error);
      return;
    }

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      reject(new ProxyError("its port is no TCP port", false));
      return;
    }

    const signal = options.signal;
    if (signal?.aborted) {
      reject(new ProxyError("aborted", false));
      return;
    }

    const socket = connect({ host: proxy.host, port: proxy.port });
    const reader = new Reader(socket);
    let settled = false;
    const finish = (error: ProxyError | null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.removeListener("error", failed);
      socket.removeListener("close", closed);
      if (error) {
        reader.release();
        socket.destroy();
        reject(error);
      } else {
        reader.release();
        resolve(socket);
      }
    };
    const abort = () => finish(new ProxyError("aborted", false));
    const failed = (error: Error) =>
      finish(new ProxyError(`the proxy ${where} is not reached: ${error.message}`, true));
    const closed = () => finish(new ProxyError(`the proxy ${where} closed the connection`, true));
    const timer = setTimeout(
      () => finish(new ProxyError(`the proxy ${where} did not answer in time`, true)),
      options.timeout ?? TIMEOUT,
    );
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", failed);
    socket.on("close", closed);
    socket.once("connect", () => {
      const handshake = proxy.kind === "socks5" ? socks5 : httpConnect;
      handshake(proxy, socket, reader, target, port).then(
        () => finish(null),
        (error: Error) =>
          finish(
            error instanceof ProxyError
              ? error
              : new ProxyError(`the proxy ${where} closed the connection`, true),
          ),
      );
    });
  });
}
