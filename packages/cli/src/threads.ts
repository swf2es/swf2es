// avmshell's background workers on node's threads: each a worker_threads
// Worker running shell-thread.js, which compiles and runs its worker's
// ABCs after the same libraries, as runShell runs the primordial's.
//
// A shareable ByteArray's memory reaches the other threads on a
// BroadcastChannel of the primordial's threads, read synchronously
// (receiveMessageOnPort) when a shared property names memory a thread has
// not seen: its code never returns to the event loop to take messages.
// A thread started later is given what its parent has seen.

import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { receiveMessageOnPort, Worker } from "node:worker_threads";
import type {
  SharedBytesMemory,
  ShellThread,
  ShellWorkerHost,
  ShellWorkerInit,
} from "@swf2es/runtime/avm2";

export interface ShellThreadsOptions {
  /** codegen.wasm, compiled: each thread instantiates it. */
  codegen: WebAssembly.Module;
  /** The libraries the primordial loaded, which each thread loads first. */
  libraries: { name: string; abc: Uint8Array }[];
  /** The primordial's ABCs, which createWorkerFromPrimordial runs. */
  abcs: { name: string; abc: Uint8Array }[];
  /**
   * Where a thread's lines go, on this thread, once its event loop takes
   * them; by default each thread writes its own to stdout as it prints
   * them, as avmshell's threads do.
   */
  print?: (line: string) => void;
  /** The primordial's threads' channel for shared memory, a background thread's parent's; by default a new one. */
  group?: string;
  /** The shared memory its parent had seen when the thread started. */
  memories?: SharedBytesMemory[];
}

/** What a thread is given, as workerData. */
export interface ShellThreadData {
  codegen: WebAssembly.Module;
  libraries: { name: string; abc: Uint8Array }[];
  abcs: { name: string; abc: Uint8Array }[];
  init: ShellWorkerInit;
  /** Whether its lines are posted to the thread that started it, rather than written to stdout. */
  post: boolean;
  group: string;
  memories: SharedBytesMemory[];
}

export interface ShellThreads {
  host: ShellWorkerHost;
  /**
   * Stop every thread still running, as avmshell interrupts its workers
   * when the primordial ends, once what they printed so far has come.
   */
  close(): Promise<void>;
  /**
   * Wait for every thread to end by itself, those started meanwhile too:
   * a worker whose code has ended leaves the workers it started running,
   * as avmshell does, and its thread, which theirs belong to, waits for them.
   */
  ended(): Promise<void>;
}

/** Threads for the background workers of a primordial that runs `options.abcs`. */
export function nodeShellThreads(options: ShellThreadsOptions): ShellThreads {
  // Each thread running, with its exit.
  const running = new Map<Worker, Promise<unknown>>();
  // Only what a thread can be posted: a library's loaded module is not.
  const libraries = options.libraries.map(({ name, abc }) => ({ name, abc }));
  const abcs = options.abcs.map(({ name, abc }) => ({ name, abc }));
  const group = options.group ?? `swf2es-shell-${randomUUID()}`;
  const channel = new BroadcastChannel(group);
  // Only read synchronously: it keeps no thread alive.
  (channel as unknown as { unref(): void }).unref();
  const memories = new Map<number, SharedBytesMemory>();
  for (const memory of options.memories ?? []) {
    memories.set(memory.id, memory);
  }

  // What the other threads shared since.
  const receive = () => {
    for (;;) {
      const m = receiveMessageOnPort(channel as never);
      if (!m) {
        break;
      }

      const memory = m.message as SharedBytesMemory;
      memories.set(memory.id, memory);
    }
  };
  const host: ShellWorkerHost = {
    start(init: ShellWorkerInit): ShellThread {
      receive();
      const data: ShellThreadData = {
        codegen: options.codegen,
        libraries,
        abcs,
        init,
        post: options.print !== undefined,
        group,
        memories: [...memories.values()],
      };
      const worker = new Worker(new URL("./shell-thread.js", import.meta.url), {
        workerData: data,
        stdout: false,
        stderr: false,
      });
      running.set(worker, new Promise((resolve) => worker.once("exit", resolve)));
      worker.on("message", (line: string) => {
        if (options.print) {
          options.print(line);
        } else {
          writeSync(1, `${line}\n`);
        }
      });
      worker.on("error", (e) => {
        const line = `swf2es: a background worker failed: ${e.stack ?? e}`;
        if (options.print) {
          options.print(line);
        } else {
          writeSync(2, `${line}\n`);
        }
      });
      worker.on("exit", () => running.delete(worker));
      return {
        terminate() {
          running.delete(worker);
          void worker.terminate();
        },
      };
    },
    share(memory: SharedBytesMemory): void {
      if (!memories.has(memory.id)) {
        memories.set(memory.id, memory);
        channel.postMessage(memory);
      }
    },
    shared(id: number): SharedBytesMemory | undefined {
      if (!memories.has(id)) {
        receive();
      }

      return memories.get(id);
    },
  };

  return {
    host,
    async close() {
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.all([...running.keys()].map((w) => w.terminate()));
      running.clear();
      channel.close();
      memories.clear();
    },
    async ended() {
      while (running.size) {
        await Promise.all(running.values());
      }
    },
  };
}
