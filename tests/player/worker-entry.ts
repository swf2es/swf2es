import { type Renderer, type WebGLRenderer, WebWorkerAdapter } from "pixi.js";
import { PixiView } from "../../packages/player/dist/render/view.js";
import { FrameReader, type SharedFrames } from "../../packages/player/dist/render/worker/frames.js";
import {
  readSharedLibrary,
  SceneLibraries,
  type SharedLibrary,
} from "../../packages/player/dist/render/worker/libraries.js";
import { workerRenderer } from "../../packages/player/dist/render/worker/renderer.js";
import { SceneMirror } from "../../packages/player/dist/render/worker/scene.js";

const scope = self as DedicatedWorkerGlobalScope;
interface Command {
  id: number;
  type: "init" | "render" | "destroy" | "release" | "library" | "dropLibrary";
  frames: SharedFrames;
  asset: SharedLibrary;
  library: number;
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  hold?: boolean;
  size?: [number, number, number];
}

let reader: FrameReader;
let mirror: SceneMirror;
let assets: SceneLibraries;
let renderer: Renderer;
let view: PixiView;
let resume: (() => void) | null = null;
let stopping = false;

async function handle(command: Command): Promise<void> {
  const { id } = command;
  switch (command.type) {
    case "init": {
      if (!scope.crossOriginIsolated) {
        throw new Error("worker test host is not isolated");
      }

      reader = new FrameReader(command.frames);
      assets = new SceneLibraries();
      assets.add(1, readSharedLibrary(command.asset));
      mirror = new SceneMirror(assets);
      renderer = await workerRenderer(
        command.canvas,
        command.width,
        command.height,
        WebWorkerAdapter,
      );
      view = new PixiView(renderer);
      scope.postMessage({ id, type: "ready" });
      return;
    }
    case "library":
      assets.add(command.library, readSharedLibrary(command.asset));
      scope.postMessage({ id, type: "registered" });
      return;
    case "dropLibrary":
      assets.drop(command.library);
      scope.postMessage({ id, type: "retired" });
      return;
    case "render": {
      const frame = reader.take();
      if (!frame) {
        scope.postMessage({ id, type: "empty" });
        return;
      }

      try {
        if (command.hold && !stopping) {
          const released = new Promise<void>((resolve) => {
            resume = resolve;
          });
          scope.postMessage({ id, type: "held", sequence: frame.sequence });
          await released;
          resume = null;
        } else {
          scope.postMessage({ id, type: "held", sequence: frame.sequence });
        }

        if (command.size) {
          renderer.resize(...command.size);
        }

        view.render(mirror.apply(frame.bytes));
        const gl = (renderer as WebGLRenderer).gl;
        const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(
          0,
          0,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        const error = gl.getError();
        if (error) {
          throw new Error(`worker GL error ${error}`);
        }

        scope.postMessage(
          { id, type: "rendered", sequence: frame.sequence, pixels: pixels.buffer },
          [pixels.buffer],
        );
      } finally {
        frame.release();
      }
      return;
    }
    case "destroy":
      view.dispose(view.stage);
      mirror.dispose();
      renderer.destroy();
      scope.postMessage({ id, type: "destroyed" });
      return;
    case "release":
      return;
  }
}

// Delay tests deliberately retain READING ownership across an await. Control
// messages remain serviceable; render/destroy commands execute in order.
let commands = Promise.resolve();
scope.onmessage = (event: MessageEvent<Command>) => {
  if (event.data.type === "release") {
    resume?.();
    scope.postMessage({ id: event.data.id, type: "released" });
    return;
  }

  if (event.data.type === "destroy") {
    stopping = true;
    resume?.();
  }

  commands = commands
    .then(() => handle(event.data))
    .catch((error: unknown) => {
      scope.postMessage({ id: event.data.id, type: "error", error: String(error) });
    });
};
