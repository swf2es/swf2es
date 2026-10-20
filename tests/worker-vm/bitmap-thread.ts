import { DOMAdapter } from "pixi.js";
import { Container } from "../../packages/player/dist/display/display.js";
import type { Drawer, ExternalInterfaceHost } from "../../packages/player/dist/hosts.js";
import { WebWorkerAdapter } from "../../vendor/pixijs/lib/environment-webworker/WebWorkerAdapter.js";
import { bitmapRenderer } from "./bitmap-renderer.ts";
import { capture, dimensions } from "./bitmap-scene.ts";
import { boot, type Kind } from "./boot.ts";
import { Bridge, type Channel } from "./bridge.ts";

const callbacks = new Map<
  string,
  NonNullable<Parameters<ExternalInterfaceHost["addCallback"]>[1]>
>();
let bridge: Bridge;
let serial = 0;
const stats = { requests: 0, sceneBytes: 0, pixelBytes: 0, waitMs: 0, unsupportedRejected: 0 };

self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "init": {
        bridge = new Bridge(
          message.shared as Channel,
          "worker",
          () => self.postMessage({ type: "pump" }),
          () => {
            throw new Error("bitmap worker accepts no synchronous page callbacks");
          },
        );
        const pixels = new Uint32Array(message.pixels as SharedArrayBuffer);
        let local: Awaited<ReturnType<typeof bitmapRenderer>> | undefined;
        if (message.mode === "worker-renderer") {
          DOMAdapter.set(WebWorkerAdapter);
          local = await bitmapRenderer();
        }

        const drawer =
          local?.drawer ??
          ({
            drawInto: () => false,
            snapshot(o, matrix, width, height, samples) {
              const count = dimensions(width, height);
              const next = serial + 1;
              const body = JSON.stringify({
                serial: next,
                node: capture(o),
                matrix,
                width,
                height,
                samples,
              });
              stats.sceneBytes += new TextEncoder().encode(body).length;
              const begun = performance.now();
              const reply = JSON.parse(bridge.call("snapshot", body)) as {
                serial: number;
                count: number;
              };
              stats.waitMs += performance.now() - begun;
              if (reply.serial !== next || reply.count !== count) {
                throw new Error("snapshot reply does not match its draw");
              }

              serial = next;
              // Only this worker requests snapshots, copying before it can issue another.
              stats.requests++;
              stats.pixelBytes += count * 4;
              return pixels.slice(0, count);
            },
          } satisfies Drawer);
        await boot(
          message.kind as Kind,
          {
            callOut: (request) => bridge.call("callOut", request),
            addCallback(name, callback) {
              if (callback) {
                callbacks.set(name, callback);
              } else {
                callbacks.delete(name);
              }
            },
          },
          (line) => bridge.call("trace", line),
          { drawer, source: `${message.kind}-bitmap` },
        );
        self.postMessage({ type: "ready" });
        // Retained only inside this worker; termination releases its renderer too.
        self.onmessage = (next: MessageEvent) => {
          try {
            switch (next.data.type) {
              case "pump":
                bridge.pump();
                break;
              case "run": {
                if (!local) {
                  const unsupported = new Container();
                  unsupported.mask = new Container();
                  try {
                    drawer.snapshot(unsupported, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, 1, 1, 1);
                    throw new Error("expected unsupported snapshot rejection");
                  } catch (error) {
                    if (!String(error).includes("does not support display effects")) {
                      throw error;
                    }
                    stats.unsupportedRejected++;
                  }
                }

                const begun = performance.now();
                const xml = callbacks.get("bitmap")?.(next.data.request, null);
                self.postMessage({
                  type: "result",
                  xml,
                  elapsed: performance.now() - begun,
                  stats: { ...stats, ...local?.stats, workerRenderers: local ? 1 : 0 },
                });
                break;
              }
            }
          } catch (error) {
            self.postMessage({ type: "error", error: String(error) });
          }
        };
        break;
      }
      case "pump":
        bridge.pump();
        break;
    }
  } catch (error) {
    self.postMessage({ type: "error", error: String(error) });
  }
};
