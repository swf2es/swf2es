import { DOMAdapter } from "pixi.js";
import type { Drawer } from "../../packages/player/dist/hosts.js";
import { WebWorkerAdapter } from "../../vendor/pixijs/lib/environment-webworker/WebWorkerAdapter.js";
import { bitmapRenderer } from "./bitmap-renderer.ts";
import { Bridge, type Channel } from "./bridge.ts";
import { type Controls, playbackModel } from "./playback-model.ts";
import { type FramePacket, type FrameSlot, FrameWriter } from "./playback-scene.ts";

let bridge: Bridge;
let model: Awaited<ReturnType<typeof playbackModel>>;
let local: Awaited<ReturnType<typeof bitmapRenderer>> | undefined;
let scene: FrameSlot;
let last = 0;
let drawn = -1;
let timer: ReturnType<typeof setInterval> | undefined;
const writer = new FrameWriter();
const stats = {
  vmMs: 0,
  encodeMs: 0,
  frames: 0,
  bitmapCalls: 0,
  bitmapWaitMs: 0,
  workerRenderers: 0,
  vmFrames: 0,
  dropped: 0,
};

function advance(dt: number, frames?: number) {
  const begin = performance.now();
  const metadata = model.advance(dt, frames);
  stats.vmMs += performance.now() - begin;
  stats.vmFrames = metadata.vmFrames;
  return metadata;
}

function publish(type: string, id: number | undefined, metadata: object, force = false) {
  let packet: FramePacket | undefined;
  if (force || model.player.changes !== drawn) {
    if (Atomics.load(new Int32Array(scene.control), 0) !== 0) {
      if (force) {
        throw new Error("playback control overlapped a pending frame");
      }
      stats.dropped++;
    } else {
      const begin = performance.now();
      packet = writer.capture(model.player.stage, scene);
      drawn = model.player.changes;
      stats.encodeMs += performance.now() - begin;
      stats.frames++;
    }
  }
  self.postMessage({
    type,
    id,
    packet,
    background: model.player.background,
    quality: model.player.quality,
    metadata,
    stats: { ...stats, ...local?.stats },
  });
}

self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  if (message.type === "pump") {
    try {
      bridge.pump();
    } catch (error) {
      self.postMessage({ type: "error", error: String(error) });
    }
    return;
  }

  try {
    let metadata: object = {};
    switch (message.type) {
      case "init": {
        scene = message.scene;
        bridge = new Bridge(
          message.shared as Channel,
          "worker",
          () => self.postMessage({ type: "pump" }),
          () => {
            throw new Error("playback probe has no synchronous page callbacks");
          },
        );
        const pixels = new Uint32Array(message.pixels as SharedArrayBuffer);
        if (message.mode === "worker-renderer") {
          DOMAdapter.set(WebWorkerAdapter);
          local = await bitmapRenderer();
          stats.workerRenderers = 1;
        }
        const remote: Drawer = {
          drawInto: () => false,
          snapshot(o, matrix, width, height, samples) {
            if (
              !Number.isInteger(width) ||
              !Number.isInteger(height) ||
              width < 1 ||
              height < 1 ||
              width > 1024 ||
              height > 1024
            ) {
              throw new RangeError("playback bitmap snapshot exceeds 1024 x 1024");
            }
            const packet = writer.capture(o, message.snapshot);
            self.postMessage({ type: "snapshot", packet });
            const begin = performance.now();
            const count = Number(
              bridge.call(
                "snapshot",
                JSON.stringify({ sequence: packet.sequence, matrix, width, height, samples }),
              ),
            );
            stats.bitmapWaitMs += performance.now() - begin;
            if (count !== width * height) {
              throw new Error("invalid playback snapshot response");
            }
            return pixels.slice(0, count);
          },
        };
        const source = local?.drawer ?? remote;
        const drawer: Drawer = {
          drawInto(...args) {
            const result = source.drawInto?.(...args) ?? false;
            if (result) {
              stats.bitmapCalls++;
            }
            return result;
          },
          snapshot(...args) {
            stats.bitmapCalls++;
            return source.snapshot(...args);
          },
        };
        model = await playbackModel(message.bytes, drawer, (line) =>
          self.postMessage({ type: "trace", line }),
        );
        metadata = {
          width: model.player.width,
          height: model.player.height,
          frameRate: model.player.frameRate,
          labels: model.labels,
        };
        break;
      }
      case "configure":
        model.configure(message.controls as Controls);
        break;
      case "step": {
        if (timer) {
          throw new Error("stop live playback before exact stepping");
        }
        const dt = last ? Math.max(0, message.now - last) : 0;
        last = message.now;
        metadata = advance(dt, message.frames);
        break;
      }
      case "start":
        if (!timer) {
          last = performance.now();
          timer = setInterval(() => {
            try {
              const now = performance.now();
              const value = advance(now - last);
              last = now;
              if (model.player.changes !== drawn) {
                publish("frame", undefined, value);
              }
            } catch (error) {
              clearInterval(timer);
              timer = undefined;
              self.postMessage({ type: "error", error: String(error) });
            }
          }, 1000 / 60);
        }
        break;
      case "stop":
        clearInterval(timer);
        timer = undefined;
        break;
      case "busy": {
        const until = performance.now() + 100;
        while (performance.now() < until) {}
        break;
      }
      default:
        throw new Error("unknown playback worker command");
    }

    if (message.type === "start" || message.type === "stop") {
      self.postMessage({
        type: "result",
        id: message.id,
        metadata,
        stats: { ...stats, ...local?.stats },
      });
    } else {
      publish("result", message.id, metadata, true);
    }
  } catch (error) {
    clearInterval(timer);
    timer = undefined;
    self.postMessage({ type: "error", id: message.id, error: String(error) });
  }
};
