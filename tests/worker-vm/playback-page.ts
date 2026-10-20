import { autoDetectRenderer } from "pixi.js";
import type { Drawer } from "../../packages/player/dist/hosts.js";
import { PixiView } from "../../packages/player/dist/render/view.js";
import { Bridge, channel } from "./bridge.ts";
import { type Controls, playbackModel } from "./playback-model.ts";
import { FrameAssets, FrameMirror, type FramePacket, frameSlot } from "./playback-scene.ts";

export type PlaybackMode = "direct" | "main-renderer" | "worker-renderer";

export async function openPlayback(bytes: Uint8Array, mode: PlaybackMode, screen?: HTMLElement) {
  if (!["direct", "main-renderer", "worker-renderer"].includes(mode)) {
    throw new Error("invalid playback mode");
  }
  if (mode !== "direct" && !globalThis.crossOriginIsolated) {
    throw new Error("VM worker playback requires cross-origin isolation");
  }
  const renderer = await autoDetectRenderer({
    preference: "webgl",
    width: 550,
    height: 400,
    resolution: 1,
    antialias: true,
    useBackBuffer: true,
    preserveDrawingBuffer: true,
  });
  const view = new PixiView(renderer);
  const assets = new FrameAssets(),
    mirror = new FrameMirror(assets),
    bitmapMirror = new FrameMirror(assets);
  const scene = mode === "direct" ? undefined : frameSlot(),
    snapshot = mode === "direct" ? undefined : frameSlot();
  const pixels =
    mode === "direct" ? undefined : new Uint32Array(new SharedArrayBuffer(1024 * 1024 * 4));
  let model: Awaited<ReturnType<typeof playbackModel>> | undefined;
  let worker: Worker | undefined;
  let bridge: Bridge | undefined;
  let pendingSnapshot: FramePacket | undefined;
  let id = 0,
    running = false,
    raf = 0,
    busy = false,
    closed = false;
  let labels: string[] = [];
  let width = 550,
    height = 400;
  const traces: string[] = [];
  const stats = {
    mode,
    vmFrames: 0,
    submissions: 0,
    vmMs: 0,
    encodeMs: 0,
    decodeMs: 0,
    renderMs: 0,
    bitmapCalls: 0,
    bitmapWaitMs: 0,
    workerRenderers: 0,
    mainSpins: 0,
    frames: 0,
    error: "",
  };
  type Reply = {
    metadata: { width?: number; height?: number; labels?: string[]; vmFrames?: number };
    stats: Partial<typeof stats>;
    packet?: FramePacket;
    background: number;
    quality: string;
  };
  const waiting = new Map<
    number,
    {
      resolve: (value: Reply) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const failure = (error: Error) => {
    stats.error = error.message;
    running = false;
    cancelAnimationFrame(raf);
    for (const request of waiting.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    waiting.clear();
    bridge?.close();
    worker?.terminate();
  };
  const command = (type: string, body: object = {}) =>
    new Promise<Reply>((resolve, reject) => {
      if (closed || stats.error) {
        reject(new Error(stats.error || "playback is closed"));
        return;
      }
      const key = ++id;
      const timer = setTimeout(() => {
        failure(new Error("playback worker command timed out"));
        bridge?.close();
        worker?.terminate();
      }, 30000);
      waiting.set(key, { resolve, reject, timer });
      worker?.postMessage({ type, id: key, ...body });
    });
  const present = (reply: Reply) => {
    Object.assign(stats, reply.stats);
    stats.mainSpins = bridge?.spins ?? 0;
    if (reply.metadata.vmFrames !== undefined) {
      stats.vmFrames = reply.metadata.vmFrames;
    }
    if (!reply.packet) {
      return;
    }
    if (!scene) {
      throw new Error("missing playback frame slot");
    }
    assets.add(reply.packet);
    const begin = performance.now();
    const root = mirror.apply(reply.packet, scene);
    stats.decodeMs += performance.now() - begin;
    renderer.background.color = reply.background;
    view.quality = reply.quality;
    const renderBegin = performance.now();
    view.render(root);
    stats.renderMs += performance.now() - renderBegin;
    stats.submissions++;
  };
  let drawn = -1;
  const drawDirect = () => {
    if (!model) {
      throw new Error("playback has not booted");
    }
    renderer.background.color = model.player.background;
    view.quality = model.player.quality;
    const at = performance.now();
    view.render(model.player.stage);
    stats.renderMs += performance.now() - at;
    stats.submissions++;
    drawn = model.player.changes;
  };
  const resize = (w: number, h: number) => {
    width = w;
    height = h;
    const resolution = screen
      ? Math.max(0.5, Math.min(screen.clientWidth / w, screen.clientHeight / h) * devicePixelRatio)
      : 1;
    renderer.resize(width, height, Math.min(resolution, 4096 / Math.max(w, h)));
  };
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    running = false;
    cancelAnimationFrame(raf);
    failure(new Error("playback closed"));
    bridge?.close();
    worker?.terminate();
    model?.player.destroy();
    view.dispose(view.stage);
    renderer.destroy();
  };
  try {
    if (mode === "direct") {
      const drawer: Drawer = {
        drawInto(...args) {
          const drawn = view.drawInto(...args);
          if (drawn) {
            stats.bitmapCalls++;
          }
          return drawn;
        },
        snapshot(...args) {
          stats.bitmapCalls++;
          return view.snapshot(...args);
        },
      };
      model = await playbackModel(bytes, drawer, (line) => traces.push(line));
      resize(model.player.width, model.player.height);
      labels = model.labels;
      drawDirect();
    } else {
      worker = new Worker("/experiment/playback-thread.js", { type: "module" });
      const shared = channel();
      bridge = new Bridge(
        shared,
        "reject",
        () => {},
        (method, body) => {
          if (method !== "snapshot" || !pendingSnapshot) {
            throw new Error("unexpected playback bitmap request");
          }
          const request = JSON.parse(body) as {
            sequence: number;
            matrix: Parameters<Drawer["snapshot"]>[1];
            width: number;
            height: number;
            samples: number;
          };
          if (
            request.sequence !== pendingSnapshot.sequence ||
            !Number.isInteger(request.width) ||
            !Number.isInteger(request.height) ||
            request.width < 1 ||
            request.height < 1 ||
            request.width > 1024 ||
            request.height > 1024 ||
            ![1, 2, 4, 8].includes(request.samples)
          ) {
            throw new Error("invalid playback bitmap request");
          }
          if (!snapshot || !pixels) {
            throw new Error("missing bitmap transport");
          }
          const root = bitmapMirror.apply(pendingSnapshot, snapshot);
          pendingSnapshot = undefined;
          const drawn = view.snapshot(
            root,
            request.matrix,
            request.width,
            request.height,
            request.samples,
          );
          pixels.set(drawn);
          return String(drawn.length);
        },
      );
      worker.onerror = (event) => failure(new Error(event.message));
      worker.onmessage = (event) => {
        const message = event.data;
        try {
          switch (message.type) {
            case "pump":
              bridge?.pump();
              break;
            case "snapshot":
              if (pendingSnapshot) {
                throw new Error("overlapping playback bitmap request");
              }
              assets.add(message.packet);
              pendingSnapshot = message.packet;
              break;
            case "trace":
              traces.push(message.line);
              break;
            case "frame":
              present(message);
              break;
            case "error":
              failure(new Error(message.error));
              bridge?.close();
              worker?.terminate();
              break;
            case "result": {
              const request = waiting.get(message.id);
              if (!request) {
                throw new Error("unexpected playback worker reply");
              }
              waiting.delete(message.id);
              clearTimeout(request.timer);
              request.resolve(message);
              break;
            }
          }
        } catch (error) {
          failure(error instanceof Error ? error : new Error(String(error)));
          bridge?.close();
          worker?.terminate();
        }
      };
      const reply = await command("init", {
        bytes,
        mode,
        shared,
        scene,
        snapshot,
        pixels: pixels?.buffer,
      });
      resize(reply.metadata.width ?? 550, reply.metadata.height ?? 400);
      labels = reply.metadata.labels ?? [];
      present(reply);
    }
    if (screen) {
      screen.replaceChildren(renderer.canvas as HTMLCanvasElement);
    }
    let last = 0;
    const step = async (now: number, frames?: number) => {
      if (busy) {
        throw new Error("a playback command is already running");
      }
      busy = true;
      try {
        if (model) {
          const begin = performance.now();
          const value = model.advance(last ? now - last : 0, frames);
          last = now;
          stats.vmMs += performance.now() - begin;
          stats.vmFrames = value.vmFrames;
          if (model.player.changes !== drawn || frames !== undefined) {
            drawDirect();
          }
        } else {
          present(await command("step", { now, frames }));
        }
      } finally {
        busy = false;
      }
    };
    const frame = (now: number) => {
      if (!running) {
        return;
      }
      raf = requestAnimationFrame(frame);
      if (!busy) {
        void step(now).catch((error) => failure(error));
      }
    };
    return {
      mode,
      labels,
      stats,
      traces,
      renderer,
      width,
      height,
      async configure(controls: Controls) {
        if (busy) {
          throw new Error("wait for the current playback step");
        }
        busy = true;
        try {
          if (model) {
            model.configure(controls);
            drawDirect();
          } else {
            present(await command("configure", { controls }));
          }
        } finally {
          busy = false;
        }
      },
      step,
      async start() {
        if (!running) {
          running = true;
          if (model) {
            last = performance.now();
            raf = requestAnimationFrame(frame);
          } else {
            present(await command("start"));
          }
        }
      },
      async stop() {
        running = false;
        cancelAnimationFrame(raf);
        while (busy && !closed && !stats.error) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (worker && !closed && !stats.error) {
          present(await command("stop"));
        }
      },
      async busyWorker() {
        if (model) {
          throw new Error("busy diagnostic requires a VM worker");
        }
        await command("busy").then(present);
      },
      async capture() {
        return (renderer.canvas as HTMLCanvasElement).toDataURL("image/png");
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

Object.assign(globalThis, { openPlayback });

function required<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`playback preview is missing ${selector}`);
  }
  return element;
}

const launch = document.querySelector<HTMLButtonElement>("#launch");
if (launch) {
  const screen = required<HTMLElement>("#screen");
  const status = required<HTMLElement>("#status");
  const mode = required<HTMLSelectElement>("#mode");
  const animation = required<HTMLSelectElement>("#animation");
  const count = required<HTMLInputElement>("#count");
  const pause = required<HTMLButtonElement>("#pause");
  const source = required<HTMLInputElement>("#source");
  const file = required<HTMLInputElement>("#file");
  const params = new URLSearchParams(location.search);
  source.value = params.get("swf") ?? "/experiment/playback.swf";
  mode.value = params.get("mode") ?? "direct";
  count.value = params.get("count") ?? "1";
  let active: Awaited<ReturnType<typeof openPlayback>> | undefined;
  let paused = false;
  let configuring = Promise.resolve();
  const configure = () => {
    const target = active;
    configuring = configuring
      .catch(() => {})
      .then(async () => {
        if (!target || target !== active) {
          return;
        }
        await target.stop();
        if (target !== active) {
          return;
        }
        await target.configure({ animation: animation.value, count: Number(count.value), paused });
        await target.start();
      });
    return configuring;
  };
  const report = (error: unknown) => {
    status.textContent = String(error);
  };
  animation.onchange = () => {
    void configure().catch(report);
  };
  count.onchange = () => {
    void configure().catch(report);
  };
  pause.onclick = () => {
    paused = !paused;
    pause.textContent = paused ? "Resume" : "Pause";
    void configure().catch(report);
  };
  launch.onclick = async () => {
    launch.disabled = true;
    active?.close();
    active = undefined;
    previousVm = 0;
    previousDraws = 0;
    previousAt = performance.now();
    try {
      status.textContent = "Loading…";
      let buffer: ArrayBuffer;
      if (file.files?.[0]) {
        buffer = await file.files[0].arrayBuffer();
      } else {
        const response = await fetch(source.value);
        if (!response.ok) {
          throw new Error(`SWF request failed: HTTP ${response.status}`);
        }
        buffer = await response.arrayBuffer();
      }
      const bytes = new Uint8Array(buffer);
      active = await openPlayback(bytes, mode.value as PlaybackMode, screen);
      Object.assign(globalThis, { playbackPreview: active });
      animation.replaceChildren(
        new Option("All", "all"),
        ...active.labels.map((name) => new Option(name, name)),
      );
      animation.value = active.labels.includes(params.get("animation") ?? "Idle")
        ? (params.get("animation") ?? "Idle")
        : "all";
      paused = false;
      pause.textContent = "Pause";
      await configure();
      previousAt = performance.now();
      previousVm = active.stats.vmFrames;
      previousDraws = active.stats.submissions;
      status.textContent = `${active.width} × ${active.height} · ${mode.selectedOptions[0].text}`;
    } catch (error) {
      report(error);
    } finally {
      launch.disabled = false;
    }
  };
  let ticks = 0;
  let previousAt = performance.now(),
    previousVm = 0,
    previousDraws = 0;
  setInterval(() => {
    required("#activity").textContent = String(++ticks);
    if (active) {
      const now = performance.now();
      if (now - previousAt >= 1000) {
        required("#rates").textContent =
          `VM: ${(((active.stats.vmFrames - previousVm) * 1000) / (now - previousAt)).toFixed(1)} frames/s · submitted: ${(((active.stats.submissions - previousDraws) * 1000) / (now - previousAt)).toFixed(1)} frames/s`;
        previousAt = now;
        previousVm = active.stats.vmFrames;
        previousDraws = active.stats.submissions;
      }
      required("#stats").textContent = JSON.stringify(active.stats, null, 2);
      if (active.stats.error) {
        status.textContent = active.stats.error;
      }
    }
  }, 250);
  window.addEventListener("pagehide", () => active?.close(), { once: true });
  if (!params.has("manual")) {
    launch.click();
  }
}
