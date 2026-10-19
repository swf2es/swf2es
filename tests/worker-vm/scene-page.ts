import { autoDetectRenderer } from "pixi.js";
import { PixiView } from "../../packages/player/dist/render/view.js";
import { FrameReader, sharedFrames } from "./scene/frames.ts";
import { readSharedLibrary, SceneLibraries } from "./scene/libraries.ts";
import { SceneMirror, SceneSnapshot } from "./scene/scene.ts";
import { sceneFixture } from "./scene-fixture.ts";
import type { SceneRequest, SceneResponse } from "./scene-messages.ts";

export async function runSceneTransport() {
  const renderer = await autoDetectRenderer({
    preference: "webgl",
    width: 128,
    height: 128,
    resolution: 1,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  renderer.background.color = 0xffffff;
  document.body.append(renderer.canvas);
  const view = new PixiView(renderer),
    fixture = sceneFixture();
  const localMirror = new SceneMirror(fixture.assets),
    encoder = new SceneSnapshot(fixture.assets);
  const buffer = new Uint8Array(new SharedArrayBuffer(131072));
  const frames = sharedFrames(131072, 2),
    reader = new FrameReader(frames),
    assets = new SceneLibraries();
  const mirror = new SceneMirror(assets),
    worker = new Worker("./scene-thread.js", { type: "module" });
  let serial = 0;
  const pending = new Map<
    number,
    {
      resolve: (sequence: number | null) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  worker.onerror = (event) => fail(new Error(event.message));
  worker.onmessage = ({ data: message }: MessageEvent<SceneResponse>) => {
    if (message.type === "libraries") {
      try {
        for (const entry of message.libraries) {
          assets.add(entry.id, readSharedLibrary(entry.asset));
        }
      } catch (error) {
        fail(new Error(String(error)));
      }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.type === "error") {
      entry.reject(new Error(message.error));
    } else {
      entry.resolve(message.sequence);
    }
  };
  const send = (
    command:
      | { type: "init"; frames: typeof frames }
      | { type: "step"; frame: number }
      | { type: "overwrite" },
  ) =>
    new Promise<number | null>((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("scene comparison timed out"));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...command, id } satisfies SceneRequest);
    });
  const pictures: { direct: string[]; local: string[]; worker: string[] } = {
    direct: [],
    local: [],
    worker: [],
  };
  const capture = (root: Parameters<PixiView["render"]>[0]) => {
    view.render(root);
    return renderer.canvas.toDataURL("image/png");
  };
  try {
    let sequence = await send({ type: "init", frames });
    for (let frame = 0; frame < 12; frame++) {
      if (frame) {
        sequence = await send({ type: "step", frame });
      }
      fixture.step(frame);
      pictures.direct.push(capture(fixture.root));
      const localBytes = buffer.subarray(0, encoder.encode(fixture.root, buffer));
      localMirror.apply(localBytes);
      // Draw after an identical record too, so the retained parsing path is covered.
      const local = localMirror.apply(localBytes);
      buffer.fill(0xee);
      pictures.local.push(capture(local));
      const packet = reader.take();
      if (!packet) {
        throw new Error("scene comparison has no frame");
      }
      let root: ReturnType<SceneMirror["apply"]>;
      try {
        if (packet.sequence !== sequence) {
          throw new Error("scene comparison read the wrong frame");
        }
        mirror.apply(packet.bytes);
        root = mirror.apply(packet.bytes);
      } finally {
        packet.release();
      }
      await send({ type: "overwrite" });
      pictures.worker.push(capture(root));
    }
    return { pictures, libraries: fixture.libraries.length };
  } finally {
    worker.terminate();
    fail(new Error("scene comparison closed"));
    view.dispose(view.stage);
    renderer.destroy(true);
  }
}
Object.assign(globalThis, { runSceneTransport });
