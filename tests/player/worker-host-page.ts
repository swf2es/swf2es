import { PixiView, Player } from "@swf2es/player";
import { autoDetectRenderer, Container as PixiContainer } from "pixi.js";
import { ShapeObject } from "/player/display/display.js";
import { morphAt } from "/player/display/morph.js";
import { WorkerView } from "/player/render/worker/host.js";
import type { RenderState } from "/player/render/worker/presentation.js";

const check = (ok: unknown, message: string) => {
  if (!ok) {
    throw new Error(message);
  }
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runWorkerHostTest(base64: string): Promise<string[]> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const player = new Player(bytes);
  await player.start();
  const renderer = await autoDetectRenderer({
    width: 160,
    height: 120,
    background: 0xffffff,
    preference: "webgl",
    antialias: false,
    useBackBuffer: true,
    preserveDrawingBuffer: true,
  });
  const main = new PixiView(renderer);
  const area = document.createElement("div");
  area.style.cssText = "position:relative;width:160px;height:120px";
  const canvas = renderer.canvas as HTMLCanvasElement;
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
  area.append(canvas);
  document.body.append(area);
  const state: RenderState = {
    width: 160,
    height: 120,
    resolution: 1,
    background: 0xffffff,
    quality: "HIGH",
    antialias: false,
    samples: 1,
    layerSamples: 1,
  };
  let redraw = false;
  const host = new WorkerView(player, main, {
    url: new URL("./out/worker/host-entry.js", import.meta.url),
    redraw: () => {
      redraw = true;
    },
    status: () => {},
  });
  host.register(bytes, player.library);
  main.bindPointer(player);
  const draw = () => {
    if (!host.render(state)) {
      main.render(player.stage);
    }
  };
  const wait = async (predicate: () => boolean, pump = true) => {
    const begin = performance.now();
    while (!predicate()) {
      check(performance.now() - begin < 15000, `host timed out: ${JSON.stringify(host.stats)}`);
      if (pump && redraw) {
        redraw = false;
        draw();
      }
      await delay(10);
    }
  };
  const pixels = (source: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    const context = copy.getContext("2d");
    if (!context) {
      throw new Error("2D canvas unavailable");
    }
    context.drawImage(source, 0, 0);
    return context.getImageData(0, 0, copy.width, copy.height).data;
  };
  const compare = async () => {
    const before = host.stats.presented;
    draw();
    await wait(() => host.stats.presented > before);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    main.render(player.stage);
    const expected = pixels(canvas);
    const actual = pixels(area.querySelectorAll("canvas")[1]);
    check(
      expected.length === actual.length && expected.every((v, i) => v === actual[i]),
      `host pixels differ: ${expected.findIndex((v, i) => v !== actual[i])}`,
    );
  };
  const results: string[] = [];
  try {
    player.root.cachedAsBitmap = true;
    player.root.scale9Grid = { xMin: 5, yMin: 5, xMax: 15, yMax: 15 };
    player.root.scroll = { xMin: 0, yMin: 0, xMax: 140, yMax: 110 };
    player.root.invalidate(7);
    draw();
    await wait(() => host.stats.state === "worker");
    await compare();
    results.push("host renders shared assets with cache, scroll and scale9 state");
    state.resolution = 1.5;
    renderer.resize(state.width, state.height, state.resolution);
    await compare();
    results.push("host resizes the worker without replacing the input canvas");

    const character = player.library.characters.get(10);
    check(character?.type === "morph", "missing morph");
    if (character?.type !== "morph") {
      throw new Error("missing morph");
    }
    const morph = ShapeObject.ofMorph(character);
    player.root.addChildAt(morph, 0);
    morph.ratio = 32768;
    const before = host.stats.presented;
    check(host.render(state), "worker not active for morph capture");
    morph.ratio = 65535;
    await wait(() => host.stats.presented > before, false);
    check(
      morph.ratio === 65535 && morph.shape === morphAt(character, 32768),
      "acknowledgement committed a newer, undrawn morph ratio",
    );
    await compare();
    results.push(
      "morph bounds commit the acknowledged ratio while scripts retain their current ratio",
    );

    let down = 0;
    main.stage.on("pointerdown", () => {
      down++;
    });
    const other = new PixiContainer();
    renderer.render(other);
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        clientX: rect.left + 10,
        clientY: rect.top + 10,
        bubbles: true,
        pointerType: "mouse",
      }),
    );
    check(down === 1, "bitmap-style main draw redirected input away from the stage");
    other.destroy();
    results.push("input stays on the main stage after another object is drawn");

    const shape = player.library.characters.get(1);
    check(shape?.type === "shape", "missing shape");
    const offList = new ShapeObject(shape?.type === "shape" ? shape : null);
    host.render(state);
    player.root.setMask(offList);
    check(!host.render(state), "off-tree mask did not fall back");
    main.render(player.stage);
    await delay(100);
    check(
      host.stats.state === "main" &&
        (area.querySelectorAll("canvas")[1] as HTMLCanvasElement).hidden,
      "late worker frame covered fallback output",
    );
    player.root.setMask(null);
    await delay(1100);
    await compare();
    results.push("unsupported scenes fall back visibly and late acknowledgements stay hidden");

    const loaded = new Player(bytes);
    await loaded.start();
    const assetWorker = (host as unknown as { worker: Worker }).worker;
    const originalPost = assetWorker.postMessage.bind(assetWorker);
    let libraryCommand: unknown = null;
    const channel = assetWorker as unknown as { postMessage(message: { type: string }): void };
    channel.postMessage = (message) => {
      if (message.type === "library") {
        libraryCommand = message;
      } else {
        originalPost(message);
      }
    };
    const dropped = host.stats.dropped;
    host.render(state);
    host.register(bytes, loaded.library);
    loaded.root.matrix = { ...loaded.root.matrix, tx: 35, ty: 15 };
    player.root.addChildAt(loaded.root, player.root.children.length);
    host.render(state);
    await wait(() => host.stats.dropped > dropped, false);
    check(libraryCommand !== null, "library registration was not held");
    originalPost(libraryCommand);
    channel.postMessage = originalPost;
    await compare();
    check(host.stats.restarts === 0, "newer frame raced an unregistered library");
    results.push(
      "newest frames wait for their library generation instead of racing control messages",
    );

    const beforeRestart = host.stats.presented;
    const oldWorker = (host as unknown as { worker: Worker }).worker;
    oldWorker.dispatchEvent(
      new ErrorEvent("error", { message: "injected worker failure", cancelable: true }),
    );
    await wait(() => host.stats.restarts === 1 && host.stats.presented > beforeRestart);
    await compare();
    check(area.querySelectorAll("canvas").length === 2, "restart retained the old canvas");
    results.push("worker failure recreates the canvas, buffers and library registrations");
    host.destroy();
    check(
      area.querySelectorAll("canvas").length === 1 && host.stats.assetBytes === 0,
      "host destroy retained worker resources",
    );
    loaded.destroy();
    results.push("destroy releases the worker canvas and shared asset registrations");
    return results;
  } finally {
    host.destroy();
    main.dispose(main.stage);
    renderer.destroy();
    player.destroy();
    area.remove();
  }
}
Object.assign(globalThis, { runWorkerHostTest });
