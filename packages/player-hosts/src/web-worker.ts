// A Web Worker running one background flash.system.Worker (workers.ts).
import { runWorkerThread } from "@swf2es/player/worker";

// The DOM's types, not a worker's, are this package's: its global scope as a worker sees it.
const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
runWorkerThread({
  post: (message) => scope.postMessage(message),
  listen: (receive) => {
    scope.onmessage = (event) => {
      // The host's first message: answered, it tells the host that what it
      // posts reaches this worker, which it then counts on while the page's
      // thread is blocked (workers.ts).
      if (event.data?.type === "ping") {
        scope.postMessage({ type: "ready" });
        return;
      }

      receive(event.data);
    };
  },
});
