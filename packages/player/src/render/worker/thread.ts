// The host supplies its worker adapter from the pinned Pixi fork. This module
// deliberately imports no worker-only adapter into the normal browser bundle.
import type { Adapter, Renderer } from "pixi.js";
import { PixiView } from "../view.js";
import { FrameReader, type SharedFrames } from "./frames.js";
import { readSharedLibrary, SceneLibraries, type SharedLibrary } from "./libraries.js";
import { PRESENTATION_BYTES, readPresentation } from "./presentation.js";
import { workerRenderer } from "./renderer.js";
import { SceneMirror } from "./scene.js";

export type WorkerCommand =
  | { type: "init"; canvas: OffscreenCanvas; frames: SharedFrames }
  | { type: "library"; id: number; asset: SharedLibrary }
  | { type: "render" }
  | { type: "destroy" };
interface Channel {
  onmessage: ((event: MessageEvent<WorkerCommand>) => void) | null;
  postMessage(message: unknown): void;
}

export function renderThread(channel: Channel, adapter: Adapter): void {
  const assets = new SceneLibraries();
  const mirror = new SceneMirror(assets);
  let renderer: Renderer | null = null;
  let view: PixiView | null = null;
  let reader: FrameReader | null = null;
  let stopped = false;
  let registered = 0;
  let size: { width: number; height: number; resolution: number } | null = null;
  let commands = Promise.resolve();

  const handle = async (command: WorkerCommand) => {
    if (stopped) {
      return;
    }

    switch (command.type) {
      case "init": {
        if (renderer) {
          throw new Error("worker renderer already initialized");
        }

        reader = new FrameReader(command.frames);
        renderer = await workerRenderer(command.canvas, 1, 1, adapter);
        view = new PixiView(renderer);
        command.canvas.addEventListener("webglcontextlost", () =>
          channel.postMessage({ type: "lost" }),
        );
        command.canvas.addEventListener("webglcontextrestored", () =>
          channel.postMessage({ type: "ready" }),
        );
        channel.postMessage({ type: "ready" });
        return;
      }
      case "library":
        assets.add(command.id, readSharedLibrary(command.asset));
        registered = Math.max(registered, command.id);
        return;
      case "render": {
        if (!renderer || !view || !reader) {
          throw new Error("worker renderer is not initialized");
        }

        const frame = reader.take();
        if (!frame) {
          return;
        }

        const begin = performance.now();
        try {
          const gl = (renderer as Renderer & { gl: WebGLRenderingContext }).gl;
          if (gl.isContextLost()) {
            channel.postMessage({ type: "lost" });
            return;
          }

          const { state, libraries } = readPresentation(frame.bytes);
          if (libraries > registered) {
            channel.postMessage({ type: "skipped", sequence: frame.sequence });
            return;
          }

          if (
            !size ||
            size.width !== state.width ||
            size.height !== state.height ||
            size.resolution !== state.resolution
          ) {
            renderer.resize(state.width, state.height, state.resolution);
            size = { width: state.width, height: state.height, resolution: state.resolution };
          }

          renderer.background.color = state.background;
          const target = renderer as Renderer & {
            backBuffer?: { antialias: boolean };
            renderTarget: { adaptor: { backBufferSamples: number; msaaSamples: number } };
          };
          if (target.backBuffer) {
            target.backBuffer.antialias = state.antialias;
          }
          target.renderTarget.adaptor.backBufferSamples = state.samples;
          target.renderTarget.adaptor.msaaSamples = state.layerSamples;
          view.quality = state.quality;
          const root = mirror.apply(frame.bytes.subarray(PRESENTATION_BYTES));
          const decoded = performance.now();
          view.render(root);
          channel.postMessage({
            type: "presented",
            sequence: frame.sequence,
            decodeMs: decoded - begin,
            renderMs: performance.now() - decoded,
          });
        } finally {
          frame.release();
        }
        return;
      }
      case "destroy":
        stopped = true;
        if (view) {
          view.dispose(view.stage);
        }
        mirror.dispose();
        renderer?.destroy();
        channel.postMessage({ type: "destroyed" });
        return;
    }
  };

  channel.onmessage = (event) => {
    commands = commands
      .then(() => handle(event.data))
      .catch((error: unknown) => {
        channel.postMessage({ type: "error", error: String(error) });
      });
  };
}
