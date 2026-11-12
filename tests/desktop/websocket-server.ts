// A WebSocket server small enough to read, for the desktop tests: node has
// a client and no server. The HTTP upgrade with its SHA-1 accept key, the
// client's masked frames unmasked, its own sent unmasked; whole messages
// only, no fragments and no extensions, which is all the tests send.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TEXT = 1;
const BINARY = 2;
const CLOSE = 8;
const PING = 9;
const PONG = 10;

/** One client, once its handshake is done. */
export interface Peer {
  /** The subprotocols it offered, and the request it came by. */
  readonly offered: string[];
  readonly request: IncomingMessage;
  /** The close frame's code once it sent one: 1005 for a frame without a code. */
  closeCode: number | null;
  /** A text message for a string, a binary one for bytes. */
  send(data: string | Uint8Array): void;
  /** A close frame, with `code` if given; the connection ends once the client's own has come. */
  close(code?: number): void;
  /** Drop the connection with no close frame. */
  destroy(): void;
  /** Read nothing more from the client, as a peer that has stopped. */
  pause(): void;
}

export interface Handlers {
  /** The subprotocol to answer with, of those offered; none by default. */
  protocol?(offered: string[]): string | undefined;
  open?(peer: Peer): void;
  message?(peer: Peer, data: string | Uint8Array): void;
  /** The client's close frame has come; it is answered, unless `answerClose` is false. */
  close?(peer: Peer, code: number): void;
  /** False leaves a client's close frame unanswered and the connection open. */
  answerClose?: boolean;
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  let head: Buffer;
  if (length < 126) {
    head = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([head, payload]);
}

function serve(socket: Duplex, request: IncomingMessage, handlers: Handlers): void {
  const offered = String(request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const chosen = handlers.protocol?.(offered);
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}${GUID}`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (chosen === undefined ? "" : `Sec-WebSocket-Protocol: ${chosen}\r\n`) +
      "\r\n",
  );

  let sentClose = false;
  const peer: Peer = {
    offered,
    request,
    closeCode: null,
    send(data) {
      socket.write(
        typeof data === "string" ? frame(TEXT, Buffer.from(data, "utf8")) : frame(BINARY, data),
      );
    },
    close(code) {
      if (sentClose) {
        return;
      }

      sentClose = true;
      const body = Buffer.alloc(code === undefined ? 0 : 2);
      if (code !== undefined) {
        body.writeUInt16BE(code, 0);
      }

      socket.write(frame(CLOSE, body));
      if (peer.closeCode !== null) {
        socket.end();
      }
    },
    destroy: () => socket.destroy(),
    pause: () => socket.pause(),
  };

  let pending: Buffer = Buffer.alloc(0);
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) {
        return;
      }

      let length = pending[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (pending.length < 4) {
          return;
        }

        length = pending.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (pending.length < 10) {
          return;
        }

        length = Number(pending.readBigUInt64BE(2));
        at = 10;
      }

      // A client's frames are always masked.
      if (pending.length < at + 4 + length) {
        return;
      }

      const mask = pending.subarray(at, at + 4);
      const payload = Buffer.from(pending.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i & 3];
      }

      const opcode = pending[0] & 0x0f;
      pending = pending.subarray(at + 4 + length);
      switch (opcode) {
        case TEXT:
          handlers.message?.(peer, payload.toString("utf8"));
          break;
        case BINARY:
          handlers.message?.(peer, new Uint8Array(payload));
          break;
        case PING:
          socket.write(frame(PONG, payload));
          break;
        case CLOSE: {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          peer.closeCode = code;
          handlers.close?.(peer, code);
          if (handlers.answerClose === false) {
            break;
          }

          if (sentClose) {
            socket.end();
          } else {
            peer.close(payload.length >= 2 ? code : undefined);
          }

          break;
        }
      }
    }
  });
  handlers.open?.(peer);
}

/**
 * A server on a port of 127.0.0.1's that the system picks, with TLS if
 * `tls` is given; a plain request is answered 426. Its connections end
 * with `server.closeAllConnections()` and the sockets `sockets` holds.
 */
export async function webSocketServer(
  handlers: Handlers,
  tls?: { key: string | Buffer; cert: string | Buffer },
): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = tls ? createSecureServer(tls) : createServer();
  const sockets = new Set<Duplex>();
  server.on("request", (_request, response) => {
    response.writeHead(426, { Connection: "close" }).end();
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serve(socket, request, handlers);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    server,
    port: (server.address() as { port: number }).port,
    close: () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      server.closeAllConnections();
      return new Promise<void>((done) => server.close(() => done()));
    },
  };
}
