import { type Container, PixiView, Player } from "@swf2es/player";
import { autoDetectRenderer, type WebGLRenderer } from "pixi.js";
import { FrameWriter, sharedFrames } from "/player/render/worker/frames.js";
import { VectorSnapshot, vectorFrameBytes } from "/player/render/worker/scene.js";

interface Reply {
  id: number;
  type: string;
  sequence?: number;
  pixels?: ArrayBuffer;
  error?: string;
}
const check = (ok: unknown, message: string) => {
  if (!ok) {
    throw new Error(message);
  }
};

async function runWorkerTest(base64: string): Promise<string[]> {
  check(crossOriginIsolated && typeof SharedArrayBuffer === "function", "SAB host not isolated");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const player = new Player(bytes);
  const frames = sharedFrames(vectorFrameBytes(128));
  const writer = new FrameWriter(frames);
  const snapshot = new VectorSnapshot(player.library);
  const assets = new SharedArrayBuffer(bytes.length);
  new Uint8Array(assets).set(bytes);
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new Worker(new URL("./out/worker/entry.js", import.meta.url), { type: "module" });
  const pending = new Map<
    number,
    { resolve: (r: Reply) => void; reject: (e: Error) => void; held: (r: Reply) => void }
  >();
  let next = 0;
  worker.onmessage = ({ data }: MessageEvent<Reply>) => {
    const request = pending.get(data.id);
    if (!request) {
      return;
    }
    if (data.type === "held") {
      request.held(data);
      return;
    }
    pending.delete(data.id);
    request.held(data);
    if (data.error) {
      request.reject(new Error(data.error));
    } else {
      request.resolve(data);
    }
  };
  worker.onerror = (event) => {
    for (const [id, p] of pending) {
      p.held({ id, type: "error" });
      p.reject(new Error(event.message));
    }
    pending.clear();
  };
  const request = (type: string, data: object = {}, transfer: Transferable[] = []) => {
    const id = ++next;
    let held!: (r: Reply) => void;
    const acquired = new Promise<Reply>((resolve) => {
      held = resolve;
    });
    const done = new Promise<Reply>((resolve, reject) => {
      pending.set(id, { resolve, reject, held });
    });
    done.catch(() => {});
    worker.postMessage({ id, type, ...data }, transfer);
    return { acquired, done };
  };
  const renderer = await autoDetectRenderer({
    preference: "webgl",
    width: player.width,
    height: player.height,
    background: 0xffffff,
    antialias: false,
    preserveDrawingBuffer: true,
    useBackBuffer: true,
  });
  const view = new PixiView(renderer);
  const reference = () => {
    view.render(player.stage);
    const gl = (renderer as WebGLRenderer).gl;
    const result = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(
      0,
      0,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      result,
    );
    return result;
  };
  const matches = (reply: Reply, expected: Uint8Array) => {
    if (!reply.pixels) {
      throw new Error("worker returned no pixels");
    }

    const actual = new Uint8Array(reply.pixels);
    check(actual.length === expected.length, "worker image size differs");
    check(
      actual.every((value, i) => value === expected[i]),
      `worker pixels differ at frame ${reply.sequence}`,
    );
  };
  const publish = () => writer.write((target) => snapshot.encode(player.stage, target));
  const results: string[] = [];

  try {
    await player.start();
    await request(
      "init",
      { frames, swf: assets, canvas: offscreen, width: player.width, height: player.height },
      [offscreen],
    ).done;
    const expectedFirst = reference();
    check(publish() === 1, "first frame not published");
    const slow = request("render", { hold: true });
    check((await slow.acquired).type === "held", "worker did not acquire frame");
    const group = player.root.children[0] as Container;
    group.matrix = { ...group.matrix, tx: 42, b: 0.2 };
    group.invalidate(1);
    check(publish() === 2, "second frame not published");
    player.root.addChildAt(player.root.children[1], 0);
    group.colorTransform = {
      rMul: 0.7,
      gMul: 1,
      bMul: 0.8,
      aMul: 0.8,
      rAdd: 12,
      gAdd: 0,
      bAdd: 10,
      aAdd: 0,
    };
    group.invalidate(1);
    check(publish() === 3, "third frame not published");
    for (let i = 0; i < 100; i++) {
      check(publish() === null, "busy slots must apply backpressure");
    }
    let heartbeat = false;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        heartbeat = true;
        resolve();
      }, 0),
    );
    await request("release").done;
    matches(await slow.done, expectedFirst);
    check(heartbeat, "main thread did not service its timer");
    results.push("held snapshot stays immutable while main continues");

    const newest = await request("render").done;
    check(newest.sequence === 3, "worker did not discard the older presentation");
    matches(newest, reference());
    results.push("latest snapshot matches main-thread Pixi pixels");

    const moved = group.children[0];
    group.removeChild(moved);
    (player.root.children[0] as Container).addChildAt(moved, 0);
    moved.visible = false;
    moved.invalidate(1);
    renderer.resize(200, 140, 1.5);
    check(publish() === 4, "frame after release not published");
    matches(await request("render", { size: [200, 140, 1.5] }).done, reference());
    results.push("resize, reparent and visibility match main-thread pixels");
    check((await request("render").done).type === "empty", "frame unexpectedly left queued");
    check(publish() === 5, "shutdown frame not published");
    const finishing = request("render", { hold: true });
    check((await finishing.acquired).type === "held", "shutdown frame not acquired");
    await request("destroy").done;
    matches(await finishing.done, reference());
    results.push("busy worker releases its frame and shuts down");
    return results;
  } finally {
    worker.terminate();
    view.dispose(view.stage);
    renderer.destroy();
    player.destroy();
    canvas.remove();
  }
}

Object.assign(globalThis, { runWorkerTest });
