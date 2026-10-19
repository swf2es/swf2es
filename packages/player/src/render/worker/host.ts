// Experimental host: the main canvas keeps input and synchronous bitmap work;
// a separate, noninteractive canvas shows frames submitted by the worker.

import type { Library } from "../../display/timeline.js";
import type { Player } from "../../player.js";
import type { PixiView } from "../view.js";
import { FrameWriter, sharedFrames } from "./frames.js";
import { SceneLibraries, type SharedLibrary, shareLibrary } from "./libraries.js";
import { PRESENTATION_BYTES, type RenderState, writePresentation } from "./presentation.js";
import { type MorphPresentation, SceneSnapshot } from "./scene.js";
import type { WorkerCommand } from "./thread.js";

interface Registration {
  id: number;
  asset: SharedLibrary;
}
interface Pending {
  at: number;
  morphs: MorphPresentation[];
}
export interface WorkerViewOptions {
  url: URL | string;
  redraw(): void;
  status(state: string, reason: string): void;
  capacity?: number;
}

export class WorkerView {
  readonly stats = {
    published: 0,
    presented: 0,
    busy: 0,
    dropped: 0,
    encodeMs: 0,
    decodeMs: 0,
    renderMs: 0,
    latencyMs: 0,
    assetBytes: 0,
    transportBytes: 0,
    restarts: 0,
    state: "starting",
    reason: "",
  };
  private readonly assets = new SceneLibraries();
  private readonly snapshot = new SceneSnapshot(this.assets);
  private readonly registrations: Registration[] = [];
  private readonly registered = new WeakSet<Library>();
  private readonly pending = new Map<number, Pending>();
  private worker: Worker | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private writer: FrameWriter | null = null;
  private ready = false;
  private enabled = true;
  private disposed = false;
  private waiting = false;
  private retryAt = 0;
  private retry = 0;
  private timer = 0;
  private capacity: number;
  private readonly inputRoot: typeof this.main.stage | null;

  constructor(
    readonly player: Player,
    readonly main: PixiView,
    readonly options: WorkerViewOptions,
  ) {
    this.inputRoot = main.renderer.events.rootTarget;
    this.capacity = options.capacity ?? 8 * 1024 * 1024;
    this.start();
  }

  register(bytes: Uint8Array, library: Library): void {
    if (this.registered.has(library) || this.disposed || !this.enabled) {
      return;
    }

    try {
      const asset = shareLibrary(bytes, library);
      let size = asset.swf.byteLength;
      for (let i = 0; i < asset.bitmaps.length; i++) {
        size += asset.bitmaps[i].pixels.byteLength;
      }
      if (this.stats.assetBytes + size > 256 * 1024 * 1024 || this.registrations.length >= 512) {
        throw new Error("worker preview asset budget exceeded");
      }

      const id = this.registrations.length + 1;
      this.assets.add(id, library);
      this.registered.add(library);
      this.registrations.push({ id, asset });
      this.stats.assetBytes += size;
      this.send({ type: "library", id, asset });
    } catch (error) {
      this.enabled = false;
      this.stop();
      this.releaseAssets();
      this.fallback(String(error));
    }
  }

  private state(state: string, reason = ""): void {
    if (this.stats.state !== state || this.stats.reason !== reason) {
      this.stats.state = state;
      this.stats.reason = reason;
      this.options.status(state, reason);
    }
  }

  private send(command: WorkerCommand): void {
    this.worker?.postMessage(command);
  }

  private start(): void {
    if (this.disposed) {
      return;
    }

    if (
      !globalThis.crossOriginIsolated ||
      typeof SharedArrayBuffer !== "function" ||
      !HTMLCanvasElement.prototype.transferControlToOffscreen
    ) {
      this.enabled = false;
      this.fallback("SharedArrayBuffer/OffscreenCanvas requires an isolated browser page");
      return;
    }

    try {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = (this.main.renderer.canvas as HTMLCanvasElement).style.cssText;
      canvas.style.pointerEvents = "none";
      canvas.hidden = true;
      canvas.setAttribute("aria-hidden", "true");
      (this.main.renderer.canvas as HTMLCanvasElement).after(canvas);
      const frames = sharedFrames(this.capacity);
      this.canvas = canvas;
      const worker = new Worker(this.options.url, { type: "module" });
      this.worker = worker;
      this.writer = new FrameWriter(frames);
      this.stats.transportBytes = frames.payload.byteLength + frames.control.byteLength;
      const offscreen = canvas.transferControlToOffscreen();
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker || this.disposed) {
          return;
        }

        switch (data.type) {
          case "ready":
            this.ready = true;
            this.options.redraw();
            break;
          case "presented": {
            const sent = this.pending.get(data.sequence);
            if (!sent) {
              return;
            }

            for (let i = 0; i < sent.morphs.length; i++) {
              const p = sent.morphs[i];
              if (p.object.morph === p.morph && this.player.stage.encloses(p.object)) {
                p.object.drawn(p.ratio);
              }
            }

            for (const sequence of this.pending.keys()) {
              if (sequence <= data.sequence) {
                this.stats.dropped += Number(sequence !== data.sequence);
                this.pending.delete(sequence);
              }
            }

            this.stats.presented++;
            this.stats.decodeMs += data.decodeMs;
            this.stats.renderMs += data.renderMs;
            this.stats.latencyMs += performance.now() - sent.at;
            canvas.hidden = false;
            this.state("worker");
            if (this.waiting) {
              this.waiting = false;
              this.options.redraw();
            }
            break;
          }
          case "skipped":
            for (const sequence of this.pending.keys()) {
              if (sequence <= data.sequence) {
                this.pending.delete(sequence);
                this.stats.dropped++;
              }
            }
            this.options.redraw();
            break;
          case "lost":
            this.ready = false;
            this.fallback("worker WebGL context lost; waiting for restoration");
            break;
          case "error":
            this.failed(String(data.error));
            break;
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.worker === worker) {
          this.failed(event.message || "worker failed");
        }
      };
      worker.onmessageerror = () => {
        if (this.worker === worker) {
          this.failed("worker message could not be decoded");
        }
      };
      worker.postMessage({ type: "init", canvas: offscreen, frames } satisfies WorkerCommand, [
        offscreen,
      ]);
      for (let i = 0; i < this.registrations.length; i++) {
        this.send({ type: "library", ...this.registrations[i] });
      }
      this.state("starting");
      this.timer = window.setInterval(() => {
        const first = this.pending.values().next().value;
        if (
          (first && performance.now() - first.at > 5000) ||
          (!this.ready && this.stats.state === "starting")
        ) {
          this.failed("worker did not respond within five seconds");
        }
      }, 5000);
    } catch (error) {
      this.enabled = false;
      this.stop();
      this.releaseAssets();
      this.fallback(String(error));
    }
  }

  private stop(): void {
    clearInterval(this.timer);
    this.worker?.terminate();
    this.worker = null;
    this.canvas?.remove();
    this.canvas = null;
    this.writer = null;
    this.ready = false;
    this.pending.clear();
    this.waiting = false;
  }

  private fallback(reason: string): void {
    this.pending.clear();
    if (this.canvas) {
      this.canvas.hidden = true;
    }
    this.state("main", reason);
    this.options.redraw();
  }

  private failed(reason: string): void {
    this.stop();
    this.fallback(reason);
    if (this.retry++ === 0 && !this.disposed && this.enabled) {
      this.stats.restarts++;
      this.start();
    } else {
      this.enabled = false;
      this.releaseAssets();
    }
  }

  /** False asks the caller to draw the current stage through its normal view. */
  render(state: RenderState): boolean {
    if (!this.enabled || !this.ready || !this.writer || this.disposed) {
      return false;
    }
    if (performance.now() < this.retryAt) {
      return false;
    }

    const morphs: MorphPresentation[] = [];
    const begin = performance.now();
    try {
      const sequence = this.writer.write((bytes) => {
        writePresentation(bytes, state, this.registrations.length);
        return (
          PRESENTATION_BYTES +
          this.snapshot.encode(this.player.stage, bytes.subarray(PRESENTATION_BYTES), morphs)
        );
      });
      this.stats.encodeMs += performance.now() - begin;
      // BitmapData.draw may have used the main renderer since its last stage draw.
      this.main.renderer.events.rootTarget = this.main.stage;
      if (sequence === null) {
        this.stats.busy++;
        this.waiting = true;
        return this.stats.state === "worker";
      }

      this.pending.set(sequence, { at: begin, morphs });
      this.stats.published++;
      this.send({ type: "render" });
      return this.stats.state === "worker";
    } catch (error) {
      this.stats.encodeMs += performance.now() - begin;
      if (
        error instanceof RangeError &&
        /capacity/.test(error.message) &&
        this.capacity < 32 * 1024 * 1024
      ) {
        this.capacity *= 2;
        this.stop();
        this.start();
      } else {
        // A loader can temporarily show unsupported content. Retry at most
        // once per second instead of throwing through every SWF frame.
        this.retryAt = performance.now() + 1000;
      }
      this.fallback(String(error));
      return false;
    }
  }

  private releaseAssets(): void {
    for (let i = 0; i < this.registrations.length; i++) {
      this.assets.drop(this.registrations[i].id);
    }
    this.registrations.length = 0;
    this.stats.assetBytes = 0;
    this.stats.transportBytes = 0;
  }

  destroy(): void {
    this.disposed = true;
    this.stop();
    this.releaseAssets();
    if (this.main.renderer.events.rootTarget === this.main.stage) {
      this.main.renderer.events.rootTarget = this.inputRoot;
    }
  }
}
