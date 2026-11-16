// The desktop app's relay (apps/desktop/src/main/relay.ts), which gathers a
// page's socket and WebSocket events into one IPC message a millisecond at
// most, with the connections that feed it in node: the first after a quiet
// spell at the end of its turn, the order kept, each connection's bytes
// joined, a full batch sent at once, and a dropped one never.
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { Connections } from "../../apps/desktop/src/main/connections.ts";
import { type Batch, FLUSH_AT, Relay } from "../../apps/desktop/src/main/relay.ts";
import { WebSocketConnections } from "../../apps/desktop/src/main/websocket-connections.ts";
import type { SocketEvent, WebSocketEvent } from "../../apps/desktop/src/shared/api.ts";
import { webSocketServer } from "./websocket-server.ts";

type Event = { type: "data"; bytes: Uint8Array } | { type: "close" } | { type: "open" };

const data = (bytes: Uint8Array): Event => ({ type: "data", bytes });
const turn = () => new Promise((done) => setImmediate(done));
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (s: string) => new TextEncoder().encode(s);

/** A relay whose batches are kept. */
function kept<E>(flushAt?: number, window?: number) {
  const batches: Batch<E>[] = [];
  const relay = new Relay<E>((batch) => batches.push(batch), flushAt, window);
  return { relay, batches };
}

/** What a batch says, "id:type" or "id:type:text" for bytes. */
const said = (batch: Batch<Event>) =>
  batch.map(([id, e]) => (e.type === "data" ? `${id}:data:${text(e.bytes)}` : `${id}:${e.type}`));

test("a quiet relay's events go in one batch at the turn's end, in order, each connection's bytes joined until its next event", async () => {
  const { relay, batches } = kept<Event>();
  relay.push(1, { type: "open" });
  relay.bytes(1, bytesOf("he"), data);
  relay.bytes(2, bytesOf("x"), data);
  relay.bytes(1, bytesOf("llo"), data);
  relay.push(1, { type: "close" });
  relay.bytes(1, bytesOf("late"), data);
  relay.bytes(2, bytesOf("yz"), data);
  assert.equal(batches.length, 0, "nothing goes before the turn ends");
  await turn();
  assert.deepEqual(batches.map(said), [
    ["1:open", "1:data:hello", "2:data:xyz", "1:close", "1:data:late"],
  ]);
  const joined = batches[0][1][1] as { bytes: Uint8Array };
  assert.equal(joined.bytes.buffer.byteLength, 5, "joined bytes are a store of their own");

  // Nothing more, no batch.
  await wait(20);
  assert.equal(batches.length, 1);
});

test("a batch that holds FLUSH_AT bytes goes at once", async () => {
  const { relay, batches } = kept<Event>();
  const chunk = new Uint8Array(64 * 1024);
  const chunks = FLUSH_AT / chunk.length;
  relay.bytes(1, chunk, data);
  relay.push(2, { type: "open" });
  for (let i = 1; i < chunks; i++) {
    relay.bytes(1, chunk, data);
  }

  assert.equal(batches.length, 1, "sent as the batch reached FLUSH_AT");
  assert.deepEqual(
    batches[0].map(([id, e]) => [id, e.type === "data" ? e.bytes.length : e.type]),
    // Another connection's event between them parts nothing: only order within one counts.
    [
      [1, FLUSH_AT],
      [2, "open"],
    ],
  );

  // What follows waits for the window that batch began.
  relay.bytes(1, chunk, data);
  assert.equal(batches.length, 1);
  await wait(20);
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 1);
});

test("the first event after a quiet spell goes at its turn's end, what follows within the window at its end", async () => {
  const { relay, batches } = kept<Event>(undefined, 40);
  relay.bytes(1, bytesOf("ping"), data);
  await turn();
  assert.deepEqual(batches.map(said), [["1:data:ping"]]);

  relay.bytes(1, bytesOf("a"), data);
  await turn();
  relay.bytes(2, bytesOf("b"), data);
  relay.bytes(1, bytesOf("c"), data);
  await turn();
  assert.equal(batches.length, 1, "held while the window lasts");
  await wait(60);
  assert.deepEqual(batches.map(said).slice(1), [["1:data:ac", "2:data:b"]]);

  // Quiet for a window: the next goes at once again.
  await wait(60);
  relay.push(1, { type: "close" });
  await turn();
  assert.deepEqual(batches.map(said).slice(2), [["1:close"]]);
});

test("a dropped batch is never sent", async () => {
  const { relay, batches } = kept<Event>();
  relay.bytes(1, bytesOf("old page"), data);
  relay.drop();
  await turn();
  assert.equal(batches.length, 0);

  // The next page's connection 1 hears only its own.
  relay.bytes(1, bytesOf("new"), data);
  await turn();
  assert.deepEqual(batches.map(said), [["1:data:new"]]);

  // One held for its window is dropped too, its timer with it.
  relay.bytes(1, bytesOf("held"), data);
  relay.drop();
  await wait(20);
  assert.equal(batches.length, 1);
});

async function listen(onConnection: (socket: Socket) => void): Promise<[Server, number]> {
  const server = createServer(onConnection);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return [server, (server.address() as { port: number }).port];
}

/** Connections as the bridge relays them (sockets.ts), the batches kept. */
function relayed() {
  const batches: Batch<SocketEvent>[] = [];
  let wake = () => {};
  const relay = new Relay<SocketEvent>((batch) => {
    batches.push(batch);
    wake();
  });
  const connections = new Connections((id, event) => {
    if (event.type === "data") {
      relay.bytes(id, event.bytes, (bytes) => ({ type: "data", bytes }));
    } else {
      relay.push(id, event);
    }
  });
  const events = () => batches.flat();
  /** Until `id` has had an event of `type`. */
  const until = async (id: number, type: SocketEvent["type"]) => {
    while (!events().some(([i, e]) => i === id && e.type === type)) {
      await new Promise<void>((done) => {
        wake = done;
      });
    }
  };
  /** `id`'s bytes, all of them so far, in order. */
  const received = (id: number) => {
    const parts = events().flatMap(([i, e]) => (i === id && e.type === "data" ? [e.bytes] : []));
    return Buffer.concat(parts);
  };
  return { connections, batches, events, until, received };
}

test("a socket's bytes come before its close", async () => {
  // Many small writes, then the end: the page hears every byte, then the close.
  const [server, port] = await listen((socket) => {
    let sent = 0;
    const burst = () => {
      for (let i = 0; i < 50; i++) {
        socket.write(`${String(sent++).padStart(6, "0")};`);
      }

      if (sent < 2000) {
        setImmediate(burst);
      } else {
        socket.end();
      }
    };
    burst();
  });
  const { connections, events, until, received } = relayed();
  connections.connect(1, "127.0.0.1", port);
  await until(1, "close");
  const types = events().map(([, e]) => e.type);
  assert.equal(types[0], "open");
  assert.equal(types.at(-1), "close");
  assert.ok(types.slice(1, -1).every((t) => t === "data"));
  const expected = Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(6, "0")};`);
  assert.equal(received(1).toString(), expected.join(""));

  server.close();
});

test("two sockets' bytes go in one batch", async () => {
  const peers: Socket[] = [];
  let connected = () => {};
  const [server, port] = await listen((socket) => {
    peers.push(socket);
    connected();
  });
  const { connections, batches, until } = relayed();
  connections.connect(1, "127.0.0.1", port);
  connections.connect(2, "127.0.0.1", port);
  await until(1, "open");
  await until(2, "open");
  while (peers.length < 2) {
    await new Promise<void>((done) => {
      connected = done;
    });
  }

  // Both write in the same turn, so both reads land in one batch; the
  // machine may be busy enough to part them once, so they have a few tries.
  const both = () =>
    batches.some((batch) => {
      const ids = new Set(batch.filter(([, e]) => e.type === "data").map(([id]) => id));
      return ids.has(1) && ids.has(2);
    });
  for (let i = 0; i < 10 && !both(); i++) {
    const seen = batches.length;
    peers[0].write("one");
    peers[1].write("two");
    while (
      !batches.slice(seen).some((b) => b.some(([id, e]) => id === 1 && e.type === "data")) ||
      !batches.slice(seen).some((b) => b.some(([id, e]) => id === 2 && e.type === "data"))
    ) {
      await until(1, "data");
      await turn();
    }
  }

  assert.ok(both(), `no batch had both: ${JSON.stringify(batches.map((b) => b.map(([i]) => i)))}`);
  connections.closeAll();
  server.close();
});

test("a socket that sends far more than a batch: each batch at most FLUSH_AT and a read, every byte in order", {
  timeout: 30_000,
}, async () => {
  const total = 8 * 1024 * 1024;
  const pattern = Buffer.alloc(total);
  for (let i = 0; i < total; i++) {
    pattern[i] = (i * 31 + (i >> 11)) & 0xff;
  }

  const [server, port] = await listen((socket) => socket.end(pattern));
  const { connections, batches, until, received } = relayed();
  connections.connect(1, "127.0.0.1", port);
  await until(1, "close");
  assert.ok(received(1).equals(pattern), "the bytes as sent");
  for (const batch of batches) {
    const size = batch.reduce((n, [, e]) => n + (e.type === "data" ? e.bytes.length : 0), 0);
    assert.ok(size < FLUSH_AT + 64 * 1024, `a batch of ${size} bytes`);
  }

  assert.ok(batches.length >= total / (FLUSH_AT + 64 * 1024));
  server.close();
});

test("WebSocket messages go gathered, each an event of its own", async () => {
  const server = await webSocketServer({
    open: (peer) => {
      for (let i = 0; i < 500; i++) {
        peer.send(i % 2 ? `text ${i}` : bytesOf(`binary ${i}`));
      }

      peer.close(1000);
    },
  });
  const batches: Batch<WebSocketEvent>[] = [];
  let wake = () => {};
  const relay = new Relay<WebSocketEvent>((batch) => {
    batches.push(batch);
    wake();
  });
  const connections = new WebSocketConnections((id, event) =>
    relay.push(id, event, event.type === "message" ? 16 : 0),
  );
  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  while (!batches.flat().some(([, e]) => e.type === "close")) {
    await new Promise<void>((done) => {
      wake = done;
    });
  }

  const events = batches.flat().map(([, e]) => e);
  assert.equal(events[0].type, "open");
  assert.equal(events.at(-1)?.type, "close");
  const messages = events.flatMap((e) => (e.type === "message" ? [e] : []));
  assert.deepEqual(
    messages.map((m) => (m.text ? text(m.data) : `bytes ${text(m.data)}`)),
    Array.from({ length: 500 }, (_, i) => (i % 2 ? `text ${i}` : `bytes binary ${i}`)),
  );
  assert.ok(batches.length < messages.length, `${batches.length} batches for 500 messages`);
  await server.close();
});
