// avmshell's background workers on node's threads: each a worker_threads
// Worker running shell-thread.js, which compiles and runs its worker's
// ABCs after the same libraries, as runShell runs the primordial's.
//
// A shareable ByteArray's memory reaches the other threads on a
// BroadcastChannel of the primordial's threads, read synchronously
// (receiveMessageOnPort) when a shared property names memory a thread has
// not seen: its code never returns to the event loop to take messages.
// A thread started later is given what its parent has seen. A channel
// holds only what was posted once it was made, so a thread that was still
// starting when a memory was shared asks for it the primordial's memory
// thread (shell-memories.ts), which subscribed before any other thread
// started, and waits for its answer.

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

/** What the memory thread is given, as workerData. */
export interface MemoriesData {
  group: string;
  /** What the primordial shared before it started. */
  memories: SharedBytesMemory[];
  /** Set once it has subscribed to the group's channel. */
  ready: Int32Array;
}

/** What the group's channel carries: a memory shared, and a question for the memory thread and its answer. */
export type MemoryMessage =
  | { type: "memory"; memory: SharedBytesMemory }
  | { type: "ask"; id: number; answered: Int32Array }
  | { type: "answer"; id: number; memory: SharedBytesMemory | null };

/** How long a thread waits for the memory thread's answer. */
const ANSWER_MS = 10_000;

export interface ShellThreads {
  host: ShellWorkerHost;
  /** The primordial's threads' channel for shared memory, which a thread it starts is given. */
  group: string;
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

  // What the other threads shared since, and the memory thread's answers.
  const receive = () => {
    for (;;) {
      const m = receiveMessageOnPort(channel as never);
      if (!m) {
        break;
      }

      const message = m.message as MemoryMessage;
      if (message.type === "memory" || (message.type === "answer" && message.memory)) {
        const memory = message.memory as SharedBytesMemory;
        memories.set(memory.id, memory);
      }
    }
  };
  // The primordial's memory thread, started, and subscribed, before any
  // other thread, or when the primordial first shares a memory.
  let keeper: Worker | null = null;
  const keep = () => {
    if (keeper || options.group) {
      return;
    }

    const ready = new Int32Array(new SharedArrayBuffer(4));
    const data: MemoriesData = { group, memories: [...memories.values()], ready };
    keeper = new Worker(new URL("./shell-memories.js", import.meta.url), { workerData: data });
    keeper.unref();
    Atomics.wait(ready, 0, 0, ANSWER_MS);
  };
  const host: ShellWorkerHost = {
    start(init: ShellWorkerInit): ShellThread {
      keep();
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
      keep();
      if (!memories.has(memory.id)) {
        memories.set(memory.id, memory);
        channel.postMessage({ type: "memory", memory } satisfies MemoryMessage);
      }
    },
    shared(id: number): SharedBytesMemory | undefined {
      if (!memories.has(id)) {
        receive();
      }

      // Shared while this thread was starting: the memory thread has it.
      if (!memories.has(id) && options.group) {
        const answered = new Int32Array(new SharedArrayBuffer(4));
        channel.postMessage({ type: "ask", id, answered } satisfies MemoryMessage);
        Atomics.wait(answered, 0, 0, ANSWER_MS);
        receive();
      }

      return memories.get(id);
    },
  };

  return {
    host,
    group,
    async close() {
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.all([...running.keys()].map((w) => w.terminate()));
      running.clear();
      await keeper?.terminate();
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
