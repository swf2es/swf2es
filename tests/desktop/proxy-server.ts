// Proxies of the tests' own, on 127.0.0.1, with node:net alone: a SOCKS5
// one (RFC 1928, with RFC 1929's username and password where it asks for
// them) and an HTTP one that makes CONNECT tunnels, each keeping the
// targets it was asked for and refusing those `refuse` names.
import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";

export interface TestProxy {
  kind: "socks5" | "http";
  port: number;
  /** "host:port" for each tunnel asked for, a name as it came, an IPv6 address in brackets. */
  targets: string[];
  /** How each SOCKS5 target came: "domain", "ipv4" or "ipv6". */
  types: string[];
  url(credentials?: string): string;
  close(): Promise<void>;
}

export interface TestProxyOptions {
  /** The username and password asked for; none by default. */
  credentials?: { username: string; password: string };
  /** A SOCKS reply code, or an HTTP status, to refuse a target with; null lets it through. */
  refuse?: (host: string, port: number) => number | null;
}

/** Reads a socket's bytes as the proxy's side of a handshake needs them. */
function reader(socket: Socket) {
  let buffered = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  let ended = false;
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    wake?.();
  };
  socket.on("data", onData);
  socket.on("end", () => {
    ended = true;
    wake?.();
  });
  const more = async () => {
    if (ended) {
      throw new Error("closed");
    }

    await new Promise<void>((woken) => {
      wake = woken;
    });
    wake = null;
  };
  return {
    async take(length: number): Promise<Buffer> {
      while (buffered.length < length) {
        await more();
      }

      const bytes = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      return bytes;
    },
    async line(): Promise<string> {
      for (;;) {
        const at = buffered.indexOf("\r\n\r\n");
        if (at >= 0) {
          return (await this.take(at + 4)).toString("latin1");
        }

        await more();
      }
    },
    /** Stop reading, handing back what came past the handshake. */
    rest(): Buffer {
      socket.removeListener("data", onData);
      socket.pause();
      return buffered;
    },
  };
}

/** Join `client` to `host`:`port`, what came past the handshake first; `answer` once connected. */
function tunnel(
  client: Socket,
  host: string,
  port: number,
  early: () => Buffer,
  answer: (ok: boolean) => void,
): void {
  const upstream = tcpConnect({ host, port });
  let connected = false;
  upstream.once("connect", () => {
    connected = true;
    answer(true);
    const rest = early();
    if (rest.length > 0) {
      upstream.write(rest);
    }

    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
  upstream.once("error", () => {
    if (!connected) {
      answer(false);
      client.end();
      return;
    }

    client.destroy();
  });
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => {
    if (connected) {
      client.destroy();
    }
  });
}

function ipv6Text(bytes: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(bytes.readUInt16BE(i).toString(16));
  }

  return groups.join(":");
}

async function socks(client: Socket, proxy: TestProxy, options: TestProxyOptions): Promise<void> {
  const read = reader(client);
  const [version, count] = await read.take(2);
  const methods = [...(await read.take(count))];
  if (version !== 5) {
    client.destroy();
    return;
  }

  const wanted = options.credentials ? 2 : 0;
  if (!methods.includes(wanted)) {
    client.end(Buffer.from([5, 0xff]));
    return;
  }

  client.write(Buffer.from([5, wanted]));
  if (options.credentials) {
    const [, userLength] = await read.take(2);
    const username = (await read.take(userLength)).toString();
    const password = (await read.take((await read.take(1))[0])).toString();
    const ok =
      username === options.credentials.username && password === options.credentials.password;
    if (!ok) {
      client.end(Buffer.from([1, 1]));
      return;
    }

    client.write(Buffer.from([1, 0]));
  }

  const [, command, , type] = await read.take(4);
  let host: string;
  switch (type) {
    case 1:
      host = [...(await read.take(4))].join(".");
      proxy.types.push("ipv4");
      break;
    case 3:
      host = (await read.take((await read.take(1))[0])).toString();
      proxy.types.push("domain");
      break;
    case 4:
      host = ipv6Text(await read.take(16));
      proxy.types.push("ipv6");
      break;
    default:
      client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
      return;
  }

  const port = (await read.take(2)).readUInt16BE(0);
  proxy.targets.push(`${type === 4 ? `[${host}]` : host}:${port}`);
  const reply = (code: number) => Buffer.from([5, code, 0, 1, 127, 0, 0, 1, 0, 0]);
  const refused = command !== 1 ? 7 : (options.refuse?.(host, port) ?? null);
  if (refused !== null) {
    client.end(reply(refused));
    return;
  }

  tunnel(client, host, port, read.rest, (ok) => client.write(reply(ok ? 0 : 5)));
}

async function http(client: Socket, proxy: TestProxy, options: TestProxyOptions): Promise<void> {
  const read = reader(client);
  const head = await read.line();
  const [request, ...headers] = head.split("\r\n");
  const match = /^CONNECT (\[[^\]]+\]|[^:\s]+):(\d+) HTTP\/1\.1$/.exec(request);
  if (!match) {
    client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
    return;
  }

  const host = match[1].replace(/^\[(.*)\]$/, "$1");
  const port = Number(match[2]);
  proxy.targets.push(`${match[1]}:${port}`);
  if (options.credentials) {
    const expected = Buffer.from(
      `${options.credentials.username}:${options.credentials.password}`,
    ).toString("base64");
    const given = headers.find((h) => /^proxy-authorization:/i.test(h));
    if (given?.replace(/^[^:]*:\s*/, "") !== `Basic ${expected}`) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="t"\r\n\r\n',
      );
      return;
    }
  }

  const refused = options.refuse?.(host, port) ?? null;
  if (refused !== null) {
    client.end(`HTTP/1.1 ${refused} Refused\r\n\r\n`);
    return;
  }

  tunnel(client, host, port, read.rest, (ok) =>
    client.write(
      ok ? "HTTP/1.1 200 Connection Established\r\n\r\n" : "HTTP/1.1 502 Bad Gateway\r\n\r\n",
    ),
  );
}

/** A proxy of `kind` on 127.0.0.1. */
export async function testProxy(
  kind: "socks5" | "http",
  options: TestProxyOptions = {},
): Promise<TestProxy> {
  const proxy: TestProxy = {
    kind,
    port: 0,
    targets: [],
    types: [],
    url: (credentials) =>
      `${kind}://${credentials ? `${credentials}@` : ""}127.0.0.1:${proxy.port}`,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        for (const socket of open) {
          socket.destroy();
        }
      }),
  };
  const open = new Set<Socket>();
  const server: Server = createServer((client) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => {});
    (kind === "socks5" ? socks : http)(client, proxy, options).catch(() => client.destroy());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  proxy.port = (server.address() as { port: number }).port;
  return proxy;
}
