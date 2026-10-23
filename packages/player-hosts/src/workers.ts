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
   * The worker script: by default this package's dist/thread/, which
   * holds web-worker.js and the modules it imports with their bare
   * specifiers made relative (build-thread.ts), so that it loads wherever
   * the package is served, as a worker sees no import map. One from
   * another origin, as a CDN's, starts through a module of the page's own
   * that imports it, which a Content-Security-Policy must allow as a
   * worker's `blob:` source.
   */
  url?: string | URL;
  /**
   * How many Web Workers to keep started ahead, for workers a script starts
   * and then waits for without returning to the event loop: by default as
   * many as the machine has cores, from 2 up to 4. The page's hosts for one
   * script URL share them, and they are let go a while after the last
   * player that used them is.
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

/**
 * How long after a Web Worker's terminate it is taken to have stopped. A
 * browser does not say, and Chrome lets a busy worker's script run on for
 * some seconds (2.5 to 4 s measured, in Chrome 156) before it stops it by
 * force; Firefox's and Safari's were not measured. The player stops a
 * terminated worker's thread so only when the worker has not stopped
 * itself first (scripting/workers.ts).
 */
const STOPPED_GRACE = 8000;

/** The workers started ahead, by script URL. */
const pools = new Map<string, Spare[]>();

/** How many hosts not yet released use each pool, and the timer that lets an unused one go. */
const users = new Map<string, { count: number; idle: ReturnType<typeof setTimeout> | null }>();

/** How long a pool no player uses keeps its workers, for the next player a page makes. */
const IDLE = 10_000;

function use(url: string | URL): void {
  const key = String(url);
  const u = users.get(key) ?? { count: 0, idle: null };
  if (u.idle !== null) {
    clearTimeout(u.idle);
    u.idle = null;
  }

  u.count++;
  users.set(key, u);
}

function release(url: string | URL): void {
  const key = String(url);
  const u = users.get(key);
  if (!u || --u.count > 0) {
    return;
  }

  u.idle = setTimeout(() => {
    for (const spare of pools.get(key) ?? []) {
      spare.worker.terminate();
    }

    pools.delete(key);
    users.delete(key);
  }, IDLE);
}

/** The page's own modules that import a worker script from another origin, by its URL. */
const importers = new Map<string, string>();

function spawn(url: string | URL): Worker {
  try {
    return new Worker(url, { type: "module" });
  } catch (error) {
    // A browser starts a worker only on a script of the page's origin.
    if (!(error instanceof DOMException && error.name === "SecurityError")) {
      throw error;
    }

    const href = new URL(url, globalThis.location?.href).href;
    let importer = importers.get(href);
    if (importer === undefined) {
      const source = `import ${JSON.stringify(href)};`;
      importer = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      importers.set(href, importer);
    }

    return new Worker(importer, { type: "module" });
  }
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
  const url = options.url ?? new URL("./thread/player-hosts/web-worker.js", import.meta.url);
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;
  const spares = options.spares ?? Math.min(4, Math.max(2, cores ?? 2));
  use(url);
  const pool = fill(url, spares);
  let released = false;
  return {
    ready: Promise.all(pool.map((s) => s.settled)).then(() => {}),
    release() {
      if (!released) {
        released = true;
        release(url);
      }
    },
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
        // A browser tells nobody when a Web Worker has stopped.
        terminate: () => {
          worker.terminate();
          return new Promise((resolve) => setTimeout(resolve, STOPPED_GRACE));
        },
      };
    },
  };
}
