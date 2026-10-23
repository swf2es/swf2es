// A worker_threads Worker running one background flash.system.Worker (node.ts).
import { parentPort } from "node:worker_threads";
import { runWorkerThread } from "@swf2es/player/worker";

const port = parentPort;
if (!port) {
  throw new Error("node-worker.js runs only as a worker_threads Worker");
}

runWorkerThread({
  post: (message) => port.postMessage(message),
  listen: (receive) => port.on("message", receive),
});
