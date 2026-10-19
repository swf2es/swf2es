import type { ExternalInterfaceHost } from "../../packages/player/dist/hosts.js";
import { readInvocation } from "../../packages/web/dist/external.js";
import { boot, type Kind } from "./boot.ts";
import { Bridge, type Channel } from "./bridge.ts";

const callbacks = new Map<
  string,
  NonNullable<Parameters<ExternalInterfaceHost["addCallback"]>[1]>
>();
let bridge: Bridge;

self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  switch (message.type) {
    case "init": {
      bridge = new Bridge(
        message.shared as Channel,
        "worker",
        () => self.postMessage({ type: "pump" }),
        (method, body) => {
          switch (method) {
            case "invoke": {
              const callback = callbacks.get(readInvocation(body).name);
              if (!callback) {
                throw new Error("callback missing");
              }

              const value = callback(body, null);
              return JSON.stringify({ xml: typeof value === "string" ? value : null });
            }
            case "stall": {
              const until = performance.now() + Number(body);
              while (performance.now() < until) {
                // Controlled worker work, independent of VM clock behavior.
              }

              return "done";
            }
            case "failure":
              throw new Error("worker transport failure");
            case "echo":
              return body;
            case "oversize":
              return "x".repeat(32 * 1024);
            case "nest":
              return Number(body) === 0 ? "leaf" : bridge.call("nest", String(Number(body) - 1));
            default:
              throw new Error(`unknown worker method: ${method}`);
          }
        },
      );
      try {
        await boot(
          message.kind as Kind,
          {
            objectID: "experiment",
            callOut: (xml) => bridge.call("callOut", xml),
            addCallback(name, callback) {
              if (callback) {
                callbacks.set(name, callback);
              } else {
                callbacks.delete(name);
              }

              bridge.call("register", JSON.stringify([name, callback !== null]));
            },
          },
          (line) => bridge.call("trace", line),
        );
        self.postMessage({ type: "ready" });
      } catch (error) {
        self.postMessage({ type: "error", error: String(error) });
      }
      break;
    }
    case "pump":
      try {
        bridge.pump();
      } catch (error) {
        self.postMessage({ type: "error", error: String(error) });
      }
      break;
    case "invoke-from-worker":
      try {
        const value = callbacks.get("outbound")?.(message.request, null);
        self.postMessage({ type: "invoked", xml: typeof value === "string" ? value : null });
      } catch (error) {
        self.postMessage({ type: "error", error: String(error) });
      }
      break;
    case "async-stall": {
      const until = performance.now() + 100;
      while (performance.now() < until) {
        // Compare main's ability to run tasks while worker work is asynchronous.
      }

      self.postMessage({ type: "async-done" });
      break;
    }
    case "wait-for-close":
      self.postMessage({ type: "waiting" });
      try {
        bridge.call("unanswered", "");
      } catch (error) {
        self.postMessage({ type: "closed", error: String(error), waits: bridge.waits });
      }
      break;
  }
};
