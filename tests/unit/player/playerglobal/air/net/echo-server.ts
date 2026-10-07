// A WebSocket server for the tests, on node's http alone: the handshake and
// RFC 6455's framing. It echoes text and binary messages, answers pings,
// picks the first subprotocol offered, and keeps what each client sent, so
// a test can see what the player sent. Text messages ask it for more:
// "close <code> <reason>" a close frame, "closeend ..." one and the end of
// the connection, "close" a frame without a code, "end" the end alone,
// "ping" a ping, "split" a message in two fragments, "empty" an empty text
// and binary message. A path of /refuse has its handshake refused. Run
// directly, for adl, it serves until killed, then prints what it kept:
//
//   node tests/unit/player/playerglobal/air/net/echo-server.ts [port]
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** What one client did. */
export interface Client {
  path: string;
  protocols: string[];
  /** Each message it sent, as [opcode, payload]: 1 text, 2 binary, 9 ping, 10 pong. */
  messages: [number, Uint8Array][];
  /** Its close frame's code and reason, once it sent one; code 1005 for none. */
  closed: { code: number; reason: string } | null;
}

export interface EchoServer {
  server: Server;
  port: number;
  clients: Client[];
  stop(): Promise<void>;
}

function frame(opcode: number, payload: Uint8Array, fin = true): Buffer {
  const head =
    payload.length < 126 ? Buffer.alloc(2) : Buffer.alloc(payload.length < 65536 ? 4 : 10);
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (payload.length < 126) {
    head[1] = payload.length;
  } else if (payload.length < 65536) {
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([head, payload]);
}

function closeFrame(code: number, reason: string): Buffer {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  return frame(8, payload);
}

function serve(socket: Duplex, client: Client): void {
  let input = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  let closing = false;
  const message = (opcode: number, payload: Buffer) => {
    client.messages.push([opcode, new Uint8Array(payload)]);
    if (opcode === 9) {
      socket.write(frame(10, payload));
      return;
    }

    if (opcode === 10) {
      return;
    }

    const text = opcode === 1 ? payload.toString("utf8") : "";
    const close = /^close(end)? (\d+) ?(.*)$/.exec(text);
    if (close) {
      closing = true;
      socket.write(closeFrame(Number(close[2]), close[3]));
      if (close[1]) {
        socket.end();
      }
    } else if (text === "close") {
      closing = true;
      socket.write(frame(8, Buffer.alloc(0)));
    } else if (text === "end") {
      socket.end();
    } else if (text === "empty") {
      socket.write(frame(1, Buffer.alloc(0)));
      socket.write(frame(2, Buffer.alloc(0)));
    } else if (text === "ping") {
      socket.write(frame(9, Buffer.from("hello")));
    } else if (text === "split") {
      socket.write(frame(1, Buffer.from("sp"), false));
      socket.write(frame(0, Buffer.from("lit")));
    } else {
      socket.write(frame(opcode, payload));
    }
  };

  socket.on("data", (data: Buffer) => {
    input = Buffer.concat([input, data]);
    for (;;) {
      if (input.length < 2) {
        return;
      }

      const fin = (input[0] & 0x80) !== 0;
      const opcode = input[0] & 0x0f;
      const masked = (input[1] & 0x80) !== 0;
      let length = input[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (input.length < 4) {
          return;
        }

        length = input.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (input.length < 10) {
          return;
        }

        length = Number(input.readBigUInt64BE(2));
        at = 10;
      }

      const mask = masked ? input.subarray(at, at + 4) : null;
      at += masked ? 4 : 0;
      if (input.length < at + length) {
        return;
      }

      const payload = Buffer.from(input.subarray(at, at + length));
      input = input.subarray(at + length);
      if (mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
      }

      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        client.closed = { code, reason: payload.subarray(2).toString("utf8") };
        if (!closing) {
          socket.write(payload.length >= 2 ? closeFrame(code, "") : frame(8, Buffer.alloc(0)));
        }

        socket.end();
        return;
      }

      if (opcode === 0) {
        fragments.push(payload);
        if (fin) {
          message(fragmentOpcode, Buffer.concat(fragments));
          fragments = [];
        }
      } else if (!fin) {
        fragmentOpcode = opcode;
        fragments = [payload];
      } else {
        message(opcode, payload);
      }
    }
  });
  socket.on("error", () => {});
}

/** Listen on 127.0.0.1 at `port`, any free one by default. */
export async function startEchoServer(port = 0): Promise<EchoServer> {
  const clients: Client[] = [];
  const server = createServer((_, response) => {
    response.writeHead(426).end();
  });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    const protocols = (request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p);
    const client: Client = { path: request.url ?? "", protocols, messages: [], closed: null };
    clients.push(client);
    if (client.path === "/refuse") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }

    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        ...(protocols.length ? [`Sec-WebSocket-Protocol: ${protocols[0]}`] : []),
        "",
        "",
      ].join("\r\n"),
    );
    serve(socket, client);
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  const open = new Set<Duplex>();
  server.on("upgrade", (_, socket: Duplex) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });

  return {
    server,
    port: (server.address() as { port: number }).port,
    clients,
    stop: () =>
      new Promise<void>((done) => {
        for (const socket of open) {
          socket.destroy();
        }

        server.close(() => done());
      }),
  };
}

if (import.meta.main) {
  const echo = await startEchoServer(Number(process.argv[2] ?? 0));
  console.log(`listening on ws://127.0.0.1:${echo.port}/`);
  process.on("SIGTERM", () => {
    for (const c of echo.clients) {
      const messages = c.messages.map(([op, p]) => [op, Buffer.from(p).toString("hex")]);
      console.log(JSON.stringify({ ...c, messages }));
    }

    process.exit(0);
  });
}
