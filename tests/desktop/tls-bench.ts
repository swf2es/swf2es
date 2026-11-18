// Compare direct TLS's reusable read buffer with TLS over an existing TCP socket.
// A separate server sends 128 MiB in small writes. The client includes desktop
// batching and V8 serialization, but not Electron IPC or certificate setup.
// Run after pnpm build: node tests/desktop/tls-bench.ts [rounds, 10]
// One warm-up pair is discarded; subsequent pairs alternate order.
import { fork } from "node:child_process";
import { once } from "node:events";
import { connect as tcpConnect } from "node:net";
import { PerformanceObserver } from "node:perf_hooks";
import { createServer } from "node:tls";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import { Relay } from "../../apps/desktop/src/main/relay.ts";
import { tlsConnect, tlsSocket } from "../../packages/player-hosts/dist/node.js";
import { tlsCertificates } from "../tls-certificates.ts";

const total = 128 * 1024 * 1024;
if (process.argv[2] === "server") {
  process.once("message", (message: { key: string; cert: string }) => {
    const bytes = Buffer.alloc(256, 42);
    const server = createServer({ key: message.key, cert: message.cert }, (peer) => {
      peer.on("error", () => {});
      peer.setNoDelay(true);
      peer.once("data", () => {
        let sent = 0;
        const burst = () => {
          for (let i = 0; i < 128 && sent < total; i++) {
            peer.write(bytes);
            sent += bytes.length;
          }

          if (sent < total && !peer.destroyed) {
            setImmediate(burst);
          }
        };

        burst();
      });
    });

    server.listen(0, "127.0.0.1", () =>
      process.send?.((server.address() as { port: number }).port),
    );
  });
} else {
  const rounds = Number(process.argv[2] ?? 10);
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error("rounds must be a positive integer");
  }

  const fixture = tlsCertificates();
  const child = fork(fileURLToPath(import.meta.url), ["server"], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  child.send({ key: fixture.key.toString(), cert: fixture.leaf.toString() });
  try {
    const [port] = (await once(child, "message", { signal: AbortSignal.timeout(10000) })) as [
      number,
    ];
    async function run(mode: "stream" | "buffer") {
      let reads = 0,
        count = 0,
        batches = 0,
        gcMs = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          gcMs += entry.duration;
        }
      });

      observer.observe({ entryTypes: ["gc"] });
      const relay = new Relay((batch) => {
        serialize(batch);
        batches++;
      });
      let start = performance.now(),
        cpu = process.cpuUsage();
      let done!: () => void;
      let reject!: (error: Error) => void;
      const completion = new Promise<void>((resolve, fail) => {
        done = resolve;
        reject = fail;
      });
      const timer = setTimeout(() => reject(new Error("TLS benchmark timed out")), 30000);
      const events = {
        open: () => {
          start = performance.now();
          cpu = process.cpuUsage();
          transport.send(Uint8Array.of(1));
        },
        data: (bytes: Uint8Array) => {
          reads++;
          count += bytes.length;
          relay.bytes(1, bytes, (data) => ({ data }));
          if (count === total) {
            done();
          }
        },
        certificate: () => {},
        error: (message: string) => {
          reject(new Error(message));
        },
        close: () => {
          if (count !== total) {
            reject(new Error("TLS closed before all bytes arrived"));
          }
        },
      };
      const options = { certificates: [{ encoded: fixture.ca, trusted: true }], timeout: 2000 };
      const transport =
        mode === "buffer"
          ? tlsConnect("localhost", port, events, options, "127.0.0.1")
          : tlsSocket(
              tcpConnect({ host: "127.0.0.1", port, noDelay: true }),
              "localhost",
              events,
              options,
            );
      try {
        await completion;
        relay.flush();
        const elapsed = performance.now() - start,
          used = process.cpuUsage(cpu);
        await new Promise((resolve) => setImmediate(resolve));
        const result = {
          mode,
          ms: elapsed,
          cpu: (used.user + used.system) / 1000,
          reads,
          batches,
          gcMs,
        };
        console.log(JSON.stringify(result));

        return result;
      } finally {
        clearTimeout(timer);
        transport.close();
        observer.disconnect();
      }
    }

    const measured: Awaited<ReturnType<typeof run>>[] = [];
    for (let i = 0; i <= rounds; i++) {
      for (const mode of i % 2
        ? (["buffer", "stream"] as const)
        : (["stream", "buffer"] as const)) {
        const result = await run(mode);
        if (i) {
          measured.push(result);
        }
      }
    }

    const median = (values: number[]) =>
      values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    for (const mode of ["stream", "buffer"] as const) {
      const rows = measured.filter((row) => row.mode === mode);
      console.log(
        "median",
        mode,
        JSON.stringify(
          Object.fromEntries(
            ["ms", "cpu", "gcMs", "reads", "batches"].map((key) => [
              key,
              median(rows.map((row) => row[key as keyof typeof row] as number)),
            ]),
          ),
        ),
      );
    }
  } finally {
    child.kill();
    await once(child, "close");
    fixture.dispose();
  }
}
