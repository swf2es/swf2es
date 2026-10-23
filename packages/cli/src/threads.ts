// avmshell's background workers on node's threads: each a worker_threads
// Worker running shell-thread.js, which compiles and runs its worker's
// ABCs after the same libraries, as runShell runs the primordial's.
import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { ShellThread, ShellWorkerHost, ShellWorkerInit } from "@swf2es/runtime/avm2";

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
}

/** What a thread is given, as workerData. */
export interface ShellThreadData {
  codegen: WebAssembly.Module;
  libraries: { name: string; abc: Uint8Array }[];
  abcs: { name: string; abc: Uint8Array }[];
  init: ShellWorkerInit;
  /** Whether its lines are posted to the thread that started it, rather than written to stdout. */
  post: boolean;
}

export interface ShellThreads {
  host: ShellWorkerHost;
  /**
   * Stop every thread still running, as avmshell interrupts its workers
   * when the primordial ends, once what they printed so far has come.
   */
  close(): Promise<void>;
}

/** Threads for the background workers of a primordial that runs `options.abcs`. */
export function nodeShellThreads(options: ShellThreadsOptions): ShellThreads {
  const running = new Set<Worker>();
  // Only what a thread can be posted: a library's loaded module is not.
  const libraries = options.libraries.map(({ name, abc }) => ({ name, abc }));
  const abcs = options.abcs.map(({ name, abc }) => ({ name, abc }));
  const host: ShellWorkerHost = {
    start(init: ShellWorkerInit): ShellThread {
      const data: ShellThreadData = {
        codegen: options.codegen,
        libraries,
        abcs,
        init,
        post: options.print !== undefined,
      };
      const worker = new Worker(new URL("./shell-thread.js", import.meta.url), {
        workerData: data,
        stdout: false,
        stderr: false,
      });
      running.add(worker);
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
      // The primordial's process ends with its own code, not its workers'.
      worker.unref();
      return {
        terminate() {
          running.delete(worker);
          void worker.terminate();
        },
      };
    },
  };

  return {
    host,
    async close() {
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.all([...running].map((w) => w.terminate()));
      running.clear();
    },
  };
}
