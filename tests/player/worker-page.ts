import { type Container, PixiView, Player } from "@swf2es/player";
import { autoDetectRenderer, type WebGLRenderer } from "pixi.js";
import { BitmapStore } from "/player/bitmap/bitmap.js";
import { drawDisplayObject } from "/player/bitmap/draw.js";
import {
  BitmapObject,
  CONTENT,
  ShapeObject,
  TextObject,
  TRANSFORM,
} from "/player/display/display.js";
import { filterDefaults } from "/player/display/filters.js";
import { FrameWriter, sharedFrames } from "/player/render/worker/frames.js";
import { SceneLibraries, shareLibrary } from "/player/render/worker/libraries.js";
import { SceneSnapshot, sceneFrameBytes } from "/player/render/worker/scene.js";

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

async function runWorkerTest(base64: string, content: string): Promise<string[]> {
  check(crossOriginIsolated && typeof SharedArrayBuffer === "function", "SAB host not isolated");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const player = new Player(bytes);
  const frames = sharedFrames(sceneFrameBytes(128, 65536));
  const writer = new FrameWriter(frames);
  const assets = new SceneLibraries();
  assets.add(1, player.library);
  const snapshot = new SceneSnapshot(assets);
  const extra = new Player(Uint8Array.from(atob(content), (c) => c.charCodeAt(0)));
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
      `worker pixels differ at frame ${reply.sequence}, byte ${actual.findIndex((v, i) => v !== expected[i])}`,
    );
  };
  const publish = () => writer.write((target) => snapshot.encode(player.stage, target));
  const results: string[] = [];

  try {
    await player.start();
    await request(
      "init",
      {
        frames,
        asset: shareLibrary(bytes, player.library),
        canvas: offscreen,
        width: player.width,
        height: player.height,
      },
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

    const compare = async () => {
      check(publish() !== null, "effects frame not published");
      const expected = reference();
      matches(await request("render").done, expected);
      return expected;
    };
    const kinds = [
      "blur",
      "glow",
      "dropShadow",
      "bevel",
      "gradientGlow",
      "gradientBevel",
      "colorMatrix",
      "convolution",
    ] as const;
    const plain = reference();
    for (const kind of kinds) {
      const filter = filterDefaults(kind);
      if (kind === "gradientGlow" || kind === "gradientBevel") {
        filter.colors = [0x00ff00, 0xff00ff];
        filter.alphas = [0.8, 1];
        filter.ratios = [0, 255];
        filter.type = "full";
      } else if (kind === "colorMatrix") {
        filter.matrix[4] = 90;
        filter.matrix[9] = 40;
      } else if (kind === "convolution") {
        filter.matrixX = filter.matrixY = 3;
        filter.matrix = [0, 1, 0, 1, 1, 1, 0, 1, 0];
        filter.divisor = 3;
      }

      group.filters = [filter, filterDefaults("colorMatrix")];
      group.children[1].filters = [filterDefaults("glow")];
      group.children[1].invalidate(1);
      group.invalidate(1);
      const filtered = await compare();
      check(
        filtered.some((v, i) => v !== plain[i]),
        `filter ${kind} did not affect the image`,
      );
      // A second draw exercises retained filter output and unchanged records.
      await compare();
    }
    group.filters = [filterDefaults("glow")];
    group.invalidate(1);
    const heldFilters = reference();
    check(publish() !== null, "filtered frame not published");
    const filtering = request("render", { hold: true });
    check((await filtering.acquired).type === "held", "filtered frame not acquired");
    group.filters = [{ ...group.filters[0], color: 0x00ff00 }];
    group.invalidate(1);
    check(publish() !== null, "updated filter frame not published");
    await request("release").done;
    matches(await filtering.done, heldFilters);
    matches(await request("render").done, reference());
    group.filters = [];
    group.children[1].filters = [];
    group.children[1].invalidate(1);
    group.invalidate(1);
    await compare();
    results.push("all numeric filters, nested chains and removal match main-thread pixels");

    for (const blend of [
      "layer",
      "multiply",
      "screen",
      "lighten",
      "darken",
      "difference",
      "add",
      "subtract",
      "invert",
      "alpha",
      "erase",
      "overlay",
      "hardlight",
      "normal",
    ]) {
      group.children[1].blendMode = blend;
      group.children[1].invalidate(1);
      await compare();
    }
    results.push("every Flash blend mode matches main-thread pixels");

    const mask = group.children[0];
    const target = group.children[1];
    target.setMask(mask);
    await compare();
    group.setMask(mask);
    await compare();
    group.setMask(null);
    await compare();
    mask.clipDepth = 2;
    mask.invalidate(1);
    group.invalidate(2);
    await compare();
    mask.clipDepth = 0;
    mask.invalidate(1);
    group.invalidate(2);
    await compare();
    results.push("script and timeline masks update and clear with matching pixels");

    await extra.start();
    assets.add(2, extra.library);
    await request("library", {
      library: 2,
      asset: shareLibrary(
        Uint8Array.from(atob(content), (c) => c.charCodeAt(0)),
        extra.library,
      ),
    }).done;
    extra.root.matrix = { ...extra.root.matrix, tx: 5, ty: 65 };
    extra.root.invalidate(1);
    player.root.addChildAt(extra.root, player.root.children.length);
    await compare();
    results.push("loaded libraries keep colliding character IDs and decoded images separate");

    const field = extra.root.children[2] as TextObject;
    field.background = true;
    field.backgroundColor = 0xdddddd;
    field.border = true;
    field.type = "input";
    field.focused = true;
    field.select(1, 4);
    field.antiAliasType = "advanced";
    field.filters = [filterDefaults("glow")];
    field.invalidate(CONTENT | TRANSFORM);
    const metrics = JSON.stringify(field.layout);
    await compare();
    check(JSON.stringify(field.layout) === metrics, "worker capture changed script text metrics");
    field.model.setHtml('<font color="#cc2266">Ab</font> <font size="13">bA Ab</font>', true);
    field.scrollH = 2;
    field.scrollV = 2;
    field.select(0, 2);
    field.invalidate(4);
    await compare();
    const device = new TextObject(null);
    device.width = 110;
    device.height = 24;
    device.left = 20;
    device.top = 28;
    device.model.defaultFormat = { ...device.model.defaultFormat, font: "_sans", size: 13 };
    device.model.setText("Worker gQ 123 åö 🚀");
    extra.root.addChildAt(device, extra.root.children.length);
    await compare();
    device.displayAsPassword = true;
    device.focused = true;
    device.type = "input";
    device.select(2, 5);
    device.invalidate(4);
    await compare();
    results.push(
      "main-thread text layout, embedded/device fonts, scrolling and selection match pixels",
    );

    const store = new BitmapStore(31, 19, true, 0x804080c0);
    const bitmap = new BitmapObject(store);
    bitmap.matrix = { ...bitmap.matrix, tx: 85, ty: 5 };
    bitmap.smoothing = true;
    extra.root.addChildAt(bitmap, extra.root.children.length);
    const sharedBitmap = new BitmapObject(store);
    sharedBitmap.matrix = { ...bitmap.matrix, ty: 25 };
    extra.root.addChildAt(sharedBitmap, extra.root.children.length);
    store.setPixel32(1, 1, 0xff22ccaa);
    await compare();
    const heldPixels = reference();
    check(publish() !== null, "bitmap snapshot not published");
    const painting = request("render", { hold: true });
    check((await painting.acquired).type === "held", "bitmap snapshot not acquired");
    store.fillRect({ x: 0, y: 0, width: 16, height: 19 }, 0xffdd44aa);
    device.model.setText("new text");
    device.invalidate(4);
    check(publish() !== null, "updated bitmap snapshot not published");
    await request("release").done;
    matches(await painting.done, heldPixels);
    matches(await request("render").done, reference());
    store.dispose();
    await compare();
    bitmap.store = new BitmapStore(31, 19, true, 0);
    const shape = extra.library.characters.get(1);
    check(shape?.type === "shape", "draw source not found");
    const drawer = new PixiView(renderer);
    try {
      drawDisplayObject(
        drawer,
        bitmap.store,
        new ShapeObject(shape?.type === "shape" ? shape : null),
        { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
        null,
        "normal",
        null,
        1,
      );
    } finally {
      drawer.dispose(drawer.stage);
    }
    check(bitmap.store.newerOnGpu, "main draw did not retain GPU pixels");
    check(publish() !== null, "GPU bitmap snapshot not published");
    check(
      bitmap.store.getPixel32(4, 4) === 0xff00aa44,
      "synchronous pixel read lost main-thread draw",
    );
    matches(await request("render").done, reference());
    extra.root.removeChild(bitmap);
    extra.root.removeChild(sharedBitmap);
    await compare();
    player.root.removeChild(extra.root);
    await compare();
    assets.drop(2);
    await request("dropLibrary", { library: 2 }).done;
    results.push("bitmap updates, held pixels, disposal and synchronous GPU draw/readback match");

    const moved = group.children[0];
    group.removeChild(moved);
    (player.root.children[0] as Container).addChildAt(moved, 0);
    moved.visible = false;
    moved.invalidate(1);
    renderer.resize(200, 140, 1.5);
    check(publish() !== null, "frame after release not published");
    matches(await request("render", { size: [200, 140, 1.5] }).done, reference());
    results.push("resize, reparent and visibility match main-thread pixels");
    check((await request("render").done).type === "empty", "frame unexpectedly left queued");
    check(publish() !== null, "shutdown frame not published");
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
    extra.destroy();
    canvas.remove();
  }
}

Object.assign(globalThis, { runWorkerTest });
