// A Web Worker running a player's background compiler (workers.ts's webCompilerHost).
import { runCompilerThread } from "@swf2es/player/compiler";

// The DOM's types, not a worker's, are this package's: its global scope as a worker sees it.
const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
runCompilerThread({
  post: (message) => scope.postMessage(message),
  listen: (receive) => {
    scope.onmessage = (event) => receive(event.data);
  },
});
