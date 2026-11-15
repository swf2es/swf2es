// What the desktop app's main process spends relaying sockets and
// WebSockets to its page: servers in a process of their own send many
// small messages, and the main process's side of them (connections.ts and
// websocket-connections.ts, through relay.ts where the build has it) takes
// them in node, without Electron. Counted: the IPC messages it would send
// (one per event without the relay), the socket's reads, the buffers each
// read made, and the collector's work.
//
//   node tests/desktop/relay-bench.ts [runs, 5]                             this checkout
//   node tests/desktop/relay-bench.ts <checkout A> <checkout B> [runs, 6]   two, interleaved
//   [--burst N]   the messages a server writes a turn, 40 by default
//   [--busy MS]   the main process's loop held MS milliseconds of every 2 MS, as by its other
//                 work; free by default, when it reads each message nearly as it comes
//
// A checkout is a directory with apps/desktop/src/main; each run is a
// process of its own, A, B, B, A, ..., and the medians are shown.
import { execFileSync, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webSocketServer } from "./websocket-server.ts";

const SOCKETS = 8;
const SOCKET_MESSAGES = 20_000;
const SOCKET_MESSAGE = 48;
const WEBSOCKETS = 4;
const WEBSOCKET_MESSAGES = 20_000;
const WEBSOCKET_MESSAGE = 32;
/** Messages a server writes, each a write of its own, before it lets the loop turn (--burst). */
const BURST = Number(process.env.SWF2ES_RELAY_BURST ?? 40);
/** Milliseconds the main process's loop is held, every other such span, as by its other work (--busy). */
const BUSY = Number(process.env.SWF2ES_RELAY_BUSY ?? 0);

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");

interface Result {
  relay: boolean;
  socketMs: number;
  reads: number;
  socketSends: number;
  /** Buffers Node made for reads, and the bytes of their stores. */
  nodeBuffers: number;
  nodeBufferBytes: number;
  /** The copies handed on, and the bytes of their stores. */
  copies: number;
  copyBytes: number;
  socketGcs: number;
  socketGcMs: number;
  /** The process's CPU time, user and system, while the sockets ran. */
  socketCpuMs: number;
  webSocketMs: number;
  webSocketCpuMs: number;
  messages: number;
  webSocketSends: number;
}

async function serve(): Promise<void> {
  const message = Buffer.alloc(SOCKET_MESSAGE, 0x61);
  const tcp = createServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", (bytes) => socket.write(bytes));
    let sent = 0;
    const burst = () => {
      for (let i = 0; i < BURST && sent < SOCKET_MESSAGES; i++, sent++) {
        socket.write(message);
      }

      if (sent < SOCKET_MESSAGES) {
        setImmediate(burst);
      } else {
        socket.end();
      }
    };
    burst();
  });
  await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", done));
  const text = "m".repeat(WEBSOCKET_MESSAGE);
  const ws = await webSocketServer({
    open: (peer) => {
      let sent = 0;
      const burst = () => {
        for (let i = 0; i < BURST && sent < WEBSOCKET_MESSAGES; i++, sent++) {
          peer.send(text);
        }

        if (sent < WEBSOCKET_MESSAGES) {
          setImmediate(burst);
        } else {
          peer.close(1000);
        }
      };
      burst();
    },
  });
  process.send?.({
    tcp: (tcp.address() as { port: number }).port,
    ws: ws.port,
  });
}

function cpuMs(since: NodeJS.CpuUsage): number {
  const { user, system } = process.cpuUsage(since);
  return (user + system) / 1000;
}

/** One checkout's run, against servers at `ports`. */
async function measure(checkout: string, ports: { tcp: number; ws: number }): Promise<Result> {
  const main = `${checkout}/apps/desktop/src/main`;
  const relayed = existsSync(`${main}/relay.ts`);
  const { Connections } = await import(pathToFileURL(`${main}/connections.ts`).href);
  const { WebSocketConnections } = await import(
    pathToFileURL(`${main}/websocket-connections.ts`).href
  );
  type Sink = { push(id: number, event: unknown, size?: number): void };
  type ByteSink = Sink & {
    bytes(id: number, bytes: Uint8Array, wrap: (b: Uint8Array) => unknown): void;
  };
  let sends = 0;
  let relay: ByteSink | null = null;
  if (relayed) {
    const { Relay } = await import(pathToFileURL(`${main}/relay.ts`).href);
    relay = new Relay(() => sends++) as ByteSink;
  }

  // Node's own read Buffers, where the build has the stream make them.
  let nodeBuffers = 0;
  let nodeBufferBytes = 0;
  const emit = Socket.prototype.emit;
  Socket.prototype.emit = function (this: Socket, name: string | symbol, ...args: unknown[]) {
    if (name === "data" && args[0] instanceof Uint8Array) {
      nodeBuffers++;
      nodeBufferBytes += args[0].buffer.byteLength;
    }

    return emit.apply(this, [name, ...args] as Parameters<typeof emit>);
  } as typeof emit;

  let gcs = 0;
  let gcMs = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcs++;
      gcMs += entry.duration;
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const busy =
    BUSY > 0
      ? setInterval(() => {
          const end = performance.now() + BUSY;
          while (performance.now() < end) {
            // Held, as by other work.
          }
        }, BUSY * 2)
      : null;

  // Sockets.
  let reads = 0;
  let copies = 0;
  let copyBytes = 0;
  let closed = 0;
  let allClosed = () => {};
  const socketsClosed = new Promise<void>((done) => {
    allClosed = done;
  });
  const wrap = (bytes: Uint8Array) => ({ type: "data", bytes });
  const connections = new Connections((id: number, event: { type: string; bytes?: Uint8Array }) => {
    if (event.type === "data" && event.bytes) {
      reads++;
      copies++;
      copyBytes += event.bytes.buffer.byteLength;
      if (relay) {
        relay.bytes(id, event.bytes, wrap);
      } else {
        sends++;
      }
    } else if (relay) {
      relay.push(id, event);
    } else {
      sends++;
    }

    if (event.type === "close" && ++closed === SOCKETS) {
      allClosed();
    }
  });
  const socketCpu = process.cpuUsage();
  const socketStart = performance.now();
  for (let id = 1; id <= SOCKETS; id++) {
    connections.connect(id, "127.0.0.1", ports.tcp);
  }

  await socketsClosed;
  // The last batch goes after the turn.
  await new Promise((done) => setImmediate(done));
  const socketMs = performance.now() - socketStart;
  const socketCpuMs = cpuMs(socketCpu);
  const socketSends = sends;
  // Entries come after the collection that made them.
  await new Promise((done) => setTimeout(done, 50));
  observer.disconnect();
  const socketGcs = gcs;
  const socketGcMs = gcMs;
  Socket.prototype.emit = emit;

  // WebSockets.
  sends = 0;
  let messages = 0;
  let wsClosed = 0;
  let allWsClosed = () => {};
  const webSocketsClosed = new Promise<void>((done) => {
    allWsClosed = done;
  });
  const webSockets = new WebSocketConnections((id: number, event: { type: string }) => {
    if (event.type === "message") {
      messages++;
    }

    if (relay) {
      relay.push(id, event, event.type === "message" ? WEBSOCKET_MESSAGE * 2 : 0);
    } else {
      sends++;
    }

    if (event.type === "close" && ++wsClosed === WEBSOCKETS) {
      allWsClosed();
    }
  });
  const webSocketCpu = process.cpuUsage();
  const webSocketStart = performance.now();
  for (let id = 1; id <= WEBSOCKETS; id++) {
    webSockets.connect(id, `ws://127.0.0.1:${ports.ws}/`, []);
  }

  await webSocketsClosed;
  await new Promise((done) => setImmediate(done));
  const webSocketMs = performance.now() - webSocketStart;
  const webSocketCpuMs = cpuMs(webSocketCpu);
  if (busy) {
    clearInterval(busy);
  }

  return {
    relay: relayed,
    socketMs,
    reads,
    socketSends,
    nodeBuffers,
    nodeBufferBytes,
    copies,
    copyBytes,
    socketGcs,
    socketGcMs,
    socketCpuMs,
    webSocketMs,
    webSocketCpuMs,
    messages,
    webSocketSends: sends,
  };
}

async function child(checkout: string): Promise<void> {
  const server = fork(fileURLToPath(import.meta.url), ["--server"], { stdio: "inherit" });
  const ports = await new Promise<{ tcp: number; ws: number }>((done) =>
    server.once("message", (m) => done(m as { tcp: number; ws: number })),
  );
  const result = await measure(checkout, ports);
  server.kill();
  console.log(JSON.stringify(result));
  process.exit(0);
}

// The children take the options by their environment.
for (const [option, variable] of [
  ["--burst", "SWF2ES_RELAY_BURST"],
  ["--busy", "SWF2ES_RELAY_BUSY"],
]) {
  const at = process.argv.indexOf(option);
  if (at > 0) {
    process.env[variable] = process.argv[at + 1];
    process.argv.splice(at, 2);
  }
}

if (process.argv[2] === "--server") {
  await serve();
} else if (process.argv[2] === "--child") {
  await child(resolve(process.argv[3]));
} else {
  const args = process.argv.slice(2);
  const checkouts = args.length >= 2 && !/^\d+$/.test(args[0]) ? [args[0], args[1]] : [root];
  const runs = Number(args[checkouts.length === 2 ? 2 : 0] ?? (checkouts.length === 2 ? 6 : 5));
  const results: Result[][] = checkouts.map(() => []);
  for (let run = 0; run < runs; run++) {
    // A, B, B, A, ...: both see the same load on the machine.
    const order = run % 2 === 0 ? checkouts.map((_, i) => i) : checkouts.map((_, i) => i).reverse();
    for (const i of order) {
      const out = execFileSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--child", resolve(checkouts[i])],
        { encoding: "utf8" },
      );
      results[i].push(JSON.parse(out.trim().split("\n").at(-1) as string));
    }
  }

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const rows: [string, (r: Result) => number, number][] = [
    ["socket reads", (r) => r.reads, 0],
    ["socket IPC messages", (r) => r.socketSends, 0],
    ["  per 1000 reads", (r) => (1000 * r.socketSends) / r.reads, 1],
    ["  per MB received", (r) => (1024 * 1024 * r.socketSends) / r.copyBytes, 0],
    ["  per second", (r) => (1000 * r.socketSends) / r.socketMs, 0],
    ["buffers made per read", (r) => (r.nodeBuffers + r.copies) / r.reads, 2],
    ["bytes received per read", (r) => r.copyBytes / r.reads, 0],
    ["store bytes made per byte", (r) => (r.nodeBufferBytes + r.copyBytes) / r.copyBytes, 2],
    ["collections (sockets)", (r) => r.socketGcs, 0],
    ["collection ms (sockets)", (r) => r.socketGcMs, 1],
    ["socket ms", (r) => r.socketMs, 0],
    ["socket CPU ms", (r) => r.socketCpuMs, 0],
    ["WebSocket messages", (r) => r.messages, 0],
    ["WebSocket IPC messages", (r) => r.webSocketSends, 0],
    ["  per second", (r) => (1000 * r.webSocketSends) / r.webSocketMs, 0],
    ["WebSocket ms", (r) => r.webSocketMs, 0],
    ["WebSocket CPU ms", (r) => r.webSocketCpuMs, 0],
  ];
  const names = checkouts.map(
    (c, i) =>
      `${checkouts.length === 2 ? "AB"[i] : ""}${results[i][0].relay ? " (relay)" : ""}`.trim() ||
      c,
  );
  console.log(
    `${SOCKETS} sockets x ${SOCKET_MESSAGES} messages of ${SOCKET_MESSAGE} bytes, ${WEBSOCKETS} WebSockets x ${WEBSOCKET_MESSAGES} of ${WEBSOCKET_MESSAGE}, ${process.env.SWF2ES_RELAY_BURST ?? 40} a turn, busy ${process.env.SWF2ES_RELAY_BUSY ?? 0} ms; medians of ${runs}`,
  );
  console.log(["", ...names].map((s, i) => (i ? s.padStart(14) : s.padEnd(28))).join(""));
  for (const [label, value, digits] of rows) {
    const cells = results.map((rs) => median(rs.map(value)).toFixed(digits).padStart(14));
    console.log(`${label.padEnd(28)}${cells.join("")}`);
  }
}
