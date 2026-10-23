// The browser's threads for flash.system.Worker (docs/workers.md): each
// background worker a module Web Worker running web-worker.ts, given
// codegen's compiled module so that it need not compile it again.
//
// A browser loads a Web Worker's modules only while the page's thread is
// in its event loop, which a primordial blocked in Mutex.lock or
// Condition.wait is not: Crossbridge starts a thread and waits for it in
// the same script. So a few workers are started ahead, as Emscripten's
// thread pool is, and a worker that starts takes one that has loaded,
// which runs what it is posted whatever the page's thread does; another
// is started in its place for the next.
import type { WorkerHost } from "@swf2es/player";
import type { ThreadStart } from "@swf2es/player/worker";

export interface WebWorkerHostOptions {
  /** codegen.wasm compiled, as the player's own codegen was made from. */
  codegen: WebAssembly.Module;
  /**
   * The worker script, web-worker.js of this package by default: a page
   * that serves the packages unbundled must give one whose imports a
   * worker can resolve, as a worker sees no import map.
   */
  url?: string | URL;
  /**
   * How many Web Workers to keep started ahead, for workers a script starts
   * and then waits for without returning to the event loop: 2 by default.
   * The page's hosts for one script URL share them.
   */
  spares?: number;
}

/** A host of Web Workers, and when the workers it started ahead have loaded. */
export interface WebWorkerHost extends WorkerHost {
  /**
   * Resolves once the workers started ahead have loaded, or failed to:
   * a page that awaits it before it plays a SWF has them for a script
   * that blocks at once.
   */
  readonly ready: Promise<void>;
}

/** A Web Worker started ahead: whether it has loaded, and the error it failed with meanwhile. */
interface Spare {
  worker: Worker;
  ready: boolean;
  failed: string | null;
  settled: Promise<void>;
}

/** The workers started ahead, by script URL. */
const pools = new Map<string, Spare[]>();

function spawn(url: string | URL): Worker {
  return new Worker(url, { type: "module" });
}

/** Keep `count` workers started ahead for `url`; where the page cannot start one, fewer. */
function fill(url: string | URL, count: number): Spare[] {
  const key = String(url);
  let pool = pools.get(key);
  if (!pool) {
    pool = [];
    pools.set(key, pool);
  }

  while (pool.length < count) {
    let worker: Worker;
    try {
      worker = spawn(url);
    } catch {
      // A policy that forbids the script: start() reports it.
      break;
    }

    let settle = () => {};
    const spare: Spare = {
      worker,
      ready: false,
      failed: null,
      settled: new Promise((resolve) => {
        settle = resolve;
      }),
    };
    worker.onmessage = (event) => {
      if (event.data?.type === "ready") {
        spare.ready = true;
        settle();
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      spare.failed = event.message;
      settle();
    };
    pool.push(spare);
  }

  return pool;
}

/** The pool's first worker that has loaded, else its first that has not failed. */
function take(pool: Spare[]): Spare | undefined {
  for (const spare of pool.filter((s) => s.failed !== null)) {
    spare.worker.terminate();
    pool.splice(pool.indexOf(spare), 1);
  }

  const at = Math.max(
    pool.findIndex((s) => s.ready),
    0,
  );
  return pool.splice(at, 1)[0];
}

/** Background workers on module Web Workers. */
export function webWorkerHost(options: WebWorkerHostOptions): WebWorkerHost {
  const url = options.url ?? new URL("./web-worker.js", import.meta.url);
  const spares = options.spares ?? 2;
  const pool = fill(url, spares);
  return {
    ready: Promise.all(pool.map((s) => s.settled)).then(() => {}),
    start(init, receive, failed) {
      const spare = take(fill(url, spares));
      const worker = spare?.worker ?? spawn(url);
      // One in its place, loaded once the page's thread is free.
      fill(url, spares);
      worker.onmessage = (event) => {
        // A worker taken before it loaded says so first.
        if (event.data?.type !== "ready") {
          receive(event.data);
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        worker.terminate();
        failed(new Error(`a background worker's thread failed: ${event.message}`));
      };
      const start: ThreadStart = { codegen: options.codegen, init };
      worker.postMessage(start);
      return {
        post: (message) => worker.postMessage(message),
        terminate: () => worker.terminate(),
      };
    },
  };
}
