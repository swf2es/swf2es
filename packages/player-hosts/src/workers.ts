// The browser's threads for flash.system.Worker (docs/workers.md): each
// background worker a module Web Worker running web-worker.ts, given
// codegen's compiled module so that it need not compile it again.
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
}

/** Background workers on module Web Workers. */
export function webWorkerHost(options: WebWorkerHostOptions): WorkerHost {
  return {
    start(init, receive, failed) {
      const worker = new Worker(options.url ?? new URL("./web-worker.js", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event) => receive(event.data);
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
