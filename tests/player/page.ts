// The test page: plays a SWF in the player, frame by frame, and gives back
// the frames asked for as PNG data URLs (runSwf), or how long each frame
// took (benchSwf), scripts and all. chrome.ts calls both.
//
// Flash anti-aliases by supersampling on a grid, none at low quality, 2×2
// at medium and 4×4 at high and best, so the page draws at that many times
// the resolution, without multisampling, and averages each block of
// samples into a pixel.
//
// A case may also ask for a zoom, as a host showing the stage larger or
// smaller than its size does: the renderer's resolution is then that many
// times the grid's, often not a whole number, and the stage is drawn at the
// zoom's inverse, so the same samples come out where Pixi's own arithmetic
// at that resolution decides.
// Or it may have the stage shown at that zoom, as a game's page does: the
// stage drawn at its size at that resolution, the frames the zoom's size.
//
// And it may ask for multisampling, as a host made with `antialias: true`
// draws: the samples are then each resolved from the multisampled targets,
// blends' backdrops and the back buffer alike (render/resolve.ts), before
// the page averages them.
import { createCodegen } from "@swf2es/codegen";
import { isAs3, readSwf, tags } from "@swf2es/format";
import {
  Container,
  type DisplayObject,
  PixiView,
  Player,
  Scripting,
  setTransformTable,
} from "@swf2es/player";
import { autoDetectRenderer } from "pixi.js";

interface Run {
  images: Record<number, string>;
  /** What the SWF's scripts traced, a line each. */
  trace: string[];
  /** The draws the transform table made (render/table.ts), in its multi-draw calls. */
  tableDraws: number;
  error: string | null;
}

/**
 * The scripting for `bytes`, through the served codegen and libraries; null
 * for a SWF with no scripts. `url` is the SWF's, for what it loads. The
 * errors nothing caught go to `uncaught` as they happen.
 */
async function scriptingFor(
  bytes: Uint8Array,
  trace: string[],
  url: string | null,
  uncaught: unknown[],
): Promise<Scripting | null> {
  const swf = readSwf(bytes);
  if (!isAs3(swf) || !swf.tags.some((t) => t.code === tags.DoABC || t.code === tags.DoABC2)) {
    return null;
  }

  const wasm = await WebAssembly.compileStreaming(fetch("/codegen/codegen.wasm"));
  const scripting = new Scripting(await createCodegen(wasm), {
    // A trace of several lines is several lines of Flash's output.
    print: (line) => trace.push(...line.split("\n")),
    // The debugger player, as adl is and as Ruffle's traces were recorded: errors carry their text.
    debugger: true,
    // The frame clock: traces that tell getTimer are the same on every run.
    realTime: null,
    // These corpus traces were recorded on a 1536×864 Flash host.
    screenCapabilities: url?.startsWith("/corpus/")
      ? { screenResolutionX: 1536, screenResolutionY: 864, pixelAspectRatio: 1, screenDPI: 72 }
      : undefined,
    url: url ? new URL(url, location.href).href : undefined,
    // A navigateToURL to "_self" would take the page itself away.
    navigate: null,
    onUncaught: (error) => uncaught.push(error),
    fetch: async (request, signal) => {
      const response = await fetch(request.url, {
        signal,
        method: request.method,
        headers: request.headers.map(([name, value]) => [name, value]),
        body: request.body ? new Uint8Array(request.body).buffer : null,
      });
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => {
        headers.push([name, value]);
      });

      // The corpus's files are served over HTTP here, but Flash loaded them from disk.
      const local = new URL(request.url).pathname.startsWith("/corpus/");
      return {
        bytes: response.ok ? new Uint8Array(await response.arrayBuffer()) : null,
        status: local ? 0 : response.status,
        headers: local ? [] : headers,
        local,
      };
    },
  });
  const libraries = await Promise.all(
    ["builtin", "playerglobal"].map(
      async (n) => new Uint8Array(await (await fetch(`/libraries/${n}.abc`)).arrayBuffer()),
    ),
  );
  await scripting.loadLibraries(libraries);
  return scripting;
}

const GRID = [1, 2, 4, 4];

/** Average each n×n block of `from`'s pixels into one of `to`'s. */
function downsample(from: HTMLCanvasElement, to: HTMLCanvasElement, n: number): void {
  const source = from.getContext("2d")?.getImageData(0, 0, from.width, from.height).data;
  const target = to.getContext("2d");
  if (!source || !target) {
    throw new Error("no 2D context");
  }

  const image = target.createImageData(to.width, to.height);
  const samples = n * n;
  for (let y = 0; y < to.height; y++) {
    for (let x = 0; x < to.width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let sy = 0; sy < n; sy++) {
          for (let sx = 0; sx < n; sx++) {
            sum += source[((y * n + sy) * from.width + x * n + sx) * 4 + c];
          }
        }

        image.data[(y * to.width + x) * 4 + c] = Math.round(sum / samples);
      }
    }
  }

  target.putImageData(image, 0, 0);
}

async function runSwf(
  base64: string,
  frames: number,
  capture: number[],
  quality: number,
  url: string | null = null,
  zoom = 1,
  antialias = false,
  table = true,
  tableMinRun?: number,
  shown = false,
): Promise<Run> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const images: Record<number, string> = {};
  const trace: string[] = [];
  let tableDraws = 0;
  let scripting: Scripting | null = null;
  const uncaught: unknown[] = [];
  // A run ends at the first error nothing caught, after the frame it came in.
  const stopOnUncaught = () => {
    if (uncaught.length > 0) {
      throw uncaught[0];
    }
  };
  try {
    scripting = await scriptingFor(bytes, trace, url, uncaught);
    const player = new Player(bytes, scripting);
    const n = GRID[quality] ?? 4;
    setTransformTable(table, tableMinRun);
    const renderer = await autoDetectRenderer({
      preference: "webgl",
      width: player.width,
      height: player.height,
      background: player.background,
      antialias,
      preserveDrawingBuffer: true,
      resolution: n * zoom,
      // Blend modes read what is below them from it (render/blend.ts).
      useBackBuffer: true,
    });
    const multi = (renderer as unknown as { gl?: WebGL2RenderingContext }).gl?.getExtension(
      "WEBGL_multi_draw",
    );
    if (multi) {
      const draw = multi.multiDrawElementsWEBGL.bind(multi);
      multi.multiDrawElementsWEBGL = (...args: Parameters<typeof draw>) => {
        tableDraws += args[6];
        draw(...args);
      };
    }

    const samples = document.createElement("canvas");
    samples.width = renderer.canvas.width;
    samples.height = renderer.canvas.height;
    const output = document.createElement("canvas");
    const shownAt = shown ? zoom : 1;
    output.width = Math.round(player.width * shownAt);
    output.height = Math.round(player.height * shownAt);
    document.body.replaceChildren(output);
    const view = new PixiView(renderer);
    // Drawn n times finer to be averaged down: the screen is the output canvas.
    view.screenScale = shownAt;
    view.stage.scale.set(shownAt / zoom);
    // BitmapData.draw of a display object renders with it, from the document class on.
    if (scripting) {
      scripting.drawer = view;
    }

    await player.start();
    stopOnUncaught();
    for (let frame = 1; frame <= frames; frame++) {
      if (frame > 1) {
        // What a frame asked to load is linked between frames, as in a browser's.
        await scripting?.settled();
        player.tick();
        stopOnUncaught();
      }

      if (capture.includes(frame)) {
        view.render(player.stage);
        // A call GL refused drew nothing, which the picture may not show.
        const gl = (renderer as unknown as { gl?: WebGLRenderingContext }).gl;
        const glError = gl?.getError();
        if (glError) {
          throw new Error(`GL error 0x${glError.toString(16)} drawing frame ${frame}`);
        }

        samples.getContext("2d")?.drawImage(renderer.canvas, 0, 0);
        downsample(samples, output, n);
        images[frame] = output.toDataURL("image/png");
      }
    }

    renderer.destroy();
    return { images, trace, tableDraws, error: null };
  } catch (e) {
    return { images, trace, tableDraws, error: describe(e, scripting) };
  }
}

/** An error's text: a JavaScript one's name and message, an AS3 one's as its runtime prints it. */
function describe(e: unknown, scripting: Scripting | null): string {
  if (e instanceof Error) {
    return `${e.name}: ${e.message}`;
  }

  try {
    return scripting ? scripting.rt.toString(e as never) : String(e);
  } catch {
    return "an error that could not be described";
  }
}

interface Bench {
  /** The view's counts at the end, and the JS heap in use before and after, where Chrome tells. */
  counts: Record<string, number>;
  /** Each frame's meter readings after the first: see meter. */
  meters: Record<string, number>[];
  /** Filled in by chrome.ts from a sampled heap profile, where asked for. */
  allocated: number;
  heap: [number, number];
  tick: number[];
  sync: number[];
  /** Pixi's part of the draw: its instructions and batches, and the GL calls issued. */
  draw: number[];
  /** GL's part: the wait for what was issued to finish. */
  gl: number[];
  /** Each render after a frame's with no tick between, whole: sync, draw and GL. */
  idle: number[];
  first: number;
  /** The GL renderer that drew: SwiftShader, or a GPU's name. */
  renderer: string;
  error: string | null;
}

/**
 * Play a SWF for `frames` frames at the stage's own resolution, timing each
 * frame's tick, the display list's sync to Pixi and Pixi's draw apart. The
 * GPU is waited for, so that what it does counts; Chrome's software GL
 * does it on the CPU anyway, and the result says which drew.
 *
 * `toggle`, from 0, adds as many sprites drawn by Graphics beside the
 * root's children, taking them off and putting them back every `toggleEvery`
 * frames, as a pool's objects and a panel shown and hidden come and go;
 * the toggle counts in the tick. -1 toggles nothing.
 */
/**
 * What a renderer does in a frame, counted by wrapping it: GL's draw calls,
 * Pixi's unbatched Graphics and batches, its render groups' instruction
 * rebuilds and their time, contexts tessellated with their vertices and
 * time, buffer uploads and their bytes, and program switches. `read` gives
 * the counts since the last read.
 */
function meter(renderer: object): { read(): Record<string, number> } {
  let counts: Record<string, number> = {};
  const add = (key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by;
  };
  const wrap = <T extends object>(
    target: T | undefined,
    method: string,
    count: (args: unknown[], took: number, self: T) => void,
  ) => {
    const object = target as Record<string, unknown> | undefined;
    const original = object?.[method] as ((...args: unknown[]) => unknown) | undefined;
    if (!object || typeof original !== "function") {
      return;
    }

    object[method] = function (this: T, ...args: unknown[]) {
      const begun = performance.now();
      const out = original.apply(this, args);
      count(args, performance.now() - begun, this);
      return out;
    };
  };
  const r = renderer as {
    uid: number;
    gl?: WebGL2RenderingContext;
    renderPipes: Record<string, object>;
    renderGroup: object;
    graphicsContext: {
      getGpuContext(context: object): { geometryData: { vertices: ArrayLike<number> } };
    };
  };
  const gl = r.gl;
  wrap(gl, "drawElements", () => add("glDraws"));
  wrap(gl, "drawArrays", () => add("glDraws"));
  wrap(gl, "useProgram", () => add("programs"));
  wrap(gl, "texSubImage2D", () => add("texUploads"));
  for (const method of ["bufferData", "bufferSubData"]) {
    wrap(gl, method, (args) => {
      add("uploads");
      const data = args[method === "bufferData" ? 1 : 2];
      // A WebGL 2 bufferSubData may take only `length` elements of its data.
      const length = method === "bufferSubData" ? (args[4] as number | undefined) : undefined;
      const view = data as ArrayBufferView & { BYTES_PER_ELEMENT?: number };
      add(
        "uploadBytes",
        typeof data === "number"
          ? data
          : length
            ? length * (view.BYTES_PER_ELEMENT ?? 1)
            : view.byteLength,
      );
    });
  }

  wrap(gl?.getExtension("WEBGL_multi_draw") ?? undefined, "multiDrawElementsWEBGL", (args) => {
    add("glDraws");
    add("tableRuns");
    add("tableDraws", args[6] as number);
  });
  wrap(r.renderPipes.graphics, "execute", () => add("aloneGraphics"));
  wrap(r.renderPipes.batch, "execute", () => add("batches"));
  wrap(r.renderGroup, "_buildInstructions", (_, took) => {
    add("rebuilds");
    add("rebuildMs", took);
  });
  // Tessellation: a context Pixi has no GPU data for yet, or one marked dirty, built now.
  const contexts = r.graphicsContext as unknown as Record<string, unknown>;
  const update = contexts.updateGpuContext as (context: object) => unknown;
  contexts.updateGpuContext = function (
    this: unknown,
    context: { dirty: boolean; _gpuData: object },
  ) {
    const fresh = context.dirty || !(context._gpuData as Record<number, unknown>)[r.uid];
    const begun = performance.now();
    const out = update.call(this, context);
    if (fresh) {
      add("tessellated");
      add("tessMs", performance.now() - begun);
      add(
        "tessVertices",
        r.graphicsContext.getGpuContext(context).geometryData.vertices.length / 2,
      );
    }

    return out;
  };
  return {
    read() {
      const out = counts;
      counts = {};
      return out;
    },
  };
}

async function benchSwf(
  base64: string,
  frames: number,
  backBuffer = false,
  idleRenders = 0,
  toggle = -1,
  antialias = false,
  toggleEvery = 1,
  nestedGroups = false,
  table = true,
  tableMinRun?: number,
): Promise<Bench> {
  setTransformTable(table, tableMinRun);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const tick: number[] = [];
  const sync: number[] = [];
  const draw: number[] = [];
  const finished: number[] = [];
  const idle: number[] = [];
  let name = "";
  try {
    const start = performance.now();
    // A scripted SWF's scripts run in the tick, which their time is part of.
    const uncaught: unknown[] = [];
    const scripting = await scriptingFor(bytes, [], null, uncaught);
    const player = new Player(bytes, scripting);
    const renderer = await autoDetectRenderer({
      preference: "webgl",
      width: player.width,
      height: player.height,
      background: player.background,
      antialias,
      resolution: 1,
      // As a host that draws blend modes makes it: a full-screen copy a frame.
      useBackBuffer: backBuffer,
    });
    document.body.replaceChildren(renderer.canvas);
    const view = new PixiView(renderer);
    if (scripting) {
      scripting.drawer = view;
    }

    await player.start();
    if (uncaught.length > 0) {
      throw uncaught[0];
    }

    // Which renderer Pixi chose and what it draws with; WebGPU when WebGL
    // could not be had, which the output must say.
    const { gl, gpu } = renderer as unknown as {
      gl?: WebGLRenderingContext;
      gpu?: { adapter: { info?: { description?: string; vendor?: string } }; device: GPUDevice };
    };
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    name = gl
      ? `WebGL, ${String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))}`
      : gpu
        ? `WebGPU, ${gpu.adapter.info?.description || gpu.adapter.info?.vendor || "unknown adapter"}`
        : "unknown renderer";
    const finish = async () => {
      // Chrome's finish returns before the GPU process has drawn; a read waits for it.
      if (gl) {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      } else if (gpu) {
        await gpu.device.queue.onSubmittedWorkDone();
      }
    };
    const heapNow = () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
      0;
    const toggled = toggle >= 0 ? await toggling(player.root, toggle) : [];
    view.render(player.stage);
    if (nestedGroups) {
      const outer = view.stage.children[0]?.children[1];
      const inner = outer?.children[1];
      if (!outer || !inner) {
        throw new Error("missing nested benchmark containers");
      }

      outer.enableRenderGroup();
      inner.enableRenderGroup();
      view.render(player.stage);
    }
    await finish();
    const first = performance.now() - start;
    const heapBefore = heapNow();
    const meters: Record<string, number>[] = [];
    const counter = meter(renderer);
    for (let frame = 2; frame <= frames; frame++) {
      const before = performance.now();
      for (const [depth, child] of toggled.entries()) {
        if (Math.floor((frame - 2) / toggleEvery) % 2) {
          player.root.removeChild(child);
        } else {
          player.root.placeAtDepth(child, depth + 1);
        }
      }

      player.tick();
      const ticked = performance.now();
      if (uncaught.length > 0) {
        throw uncaught[0];
      }

      view.prepare(player.stage);
      const synced = performance.now();
      renderer.render(view.stage);
      const drawn = performance.now();
      await finish();
      tick.push(ticked - before);
      sync.push(synced - ticked);
      draw.push(drawn - synced);
      finished.push(performance.now() - drawn);
      meters.push(counter.read());
      // Renders no tick came before, as a host that draws on every animation frame does.
      for (let k = 0; k < idleRenders; k++) {
        const begun = performance.now();
        view.render(player.stage);
        await finish();
        idle.push(performance.now() - begun);
      }
    }

    const counts = { ...view.counts };
    const heap: [number, number] = [heapBefore, heapNow()];
    renderer.destroy();
    return {
      counts,
      meters,
      allocated: 0,
      heap,
      tick,
      sync,
      draw,
      gl: finished,
      idle,
      first,
      renderer: name,
      error: null,
    };
  } catch (e) {
    return {
      counts: {},
      meters: [],
      allocated: 0,
      heap: [0, 0],
      tick,
      sync,
      draw,
      gl: finished,
      idle,
      first: 0,
      renderer: name,
      error: describe(e, null),
    };
  }
}

/**
 * The root's children and `count` sprites more, each drawn with 40 round
 * rectangles of its own, at the depths after them: what `toggle` takes off
 * and puts back.
 */
async function toggling(root: Player["root"], count: number): Promise<DisplayObject[]> {
  const { Drawing } = (await import("/player/display/drawing.js" as string)) as {
    Drawing: new () => {
      beginFill(fill: { type: "solid"; color: number }): void;
      drawRoundRect(x: number, y: number, w: number, h: number, ew: number, eh: number): void;
      endFill(): void;
    };
  };
  const children = [...root.children];
  for (let i = 0; i < count; i++) {
    const sprite = new Container();
    const drawing = new Drawing();
    for (let k = 0; k < 40; k++) {
      drawing.beginFill({ type: "solid", color: 0xff000000 | ((i * 7919 + k * 997) & 0xffffff) });
      drawing.drawRoundRect(k * 3, k * 2, 30, 20, 6, 6);
      drawing.endFill();
    }

    sprite.drawing = drawing as unknown as Container["drawing"];
    sprite.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: (i * 37) % 700, ty: (i * 53) % 500 });
    children.push(sprite);
  }

  for (const [depth, child] of children.entries()) {
    root.placeAtDepth(child, depth + 1);
  }

  return children;
}

/** The memory of the codegen instance made last, the opened SWF's, for stepSwf to tell its size. */
let codegenMemory: WebAssembly.Memory | null = null;
const instantiate = WebAssembly.instantiate.bind(WebAssembly);
WebAssembly.instantiate = (async (module: WebAssembly.Module, imports?: WebAssembly.Imports) => {
  const instance = await instantiate(module, imports);
  const memory = instance.exports.memory;
  codegenMemory = memory instanceof WebAssembly.Memory ? memory : codegenMemory;
  return instance;
}) as typeof WebAssembly.instantiate;

/** The SWF openSwf started, which stepSwf plays on: for leak.ts, which measures the heap between steps. */
let opened: {
  player: Player;
  scripting: Scripting | null;
  trace: string[];
  uncaught: unknown[];
} | null = null;

/** Start a SWF, with no renderer, for stepSwf to play; any SWF opened before is let go. */
async function openSwf(base64: string, url: string | null): Promise<string | null> {
  opened = null;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const trace: string[] = [];
  const uncaught: unknown[] = [];
  let scripting: Scripting | null = null;
  try {
    scripting = await scriptingFor(bytes, trace, url, uncaught);
    const player = new Player(bytes, scripting);
    await player.start();
    opened = { player, scripting, trace, uncaught };
    return null;
  } catch (e) {
    return describe(e, scripting);
  }
}

/**
 * Play the opened SWF's frames until it has traced `lines` lines, or for
 * `frames` frames at most: the lines it has traced, the size of its
 * codegen's memory, and what stopped it.
 */
async function stepSwf(
  lines: number,
  frames: number,
): Promise<{ lines: number; codegen: number; error: string | null }> {
  if (!opened) {
    return { lines: 0, codegen: 0, error: "no SWF is open" };
  }

  const { player, scripting, trace, uncaught } = opened;
  try {
    for (let frame = 0; frame < frames && trace.length < lines; frame++) {
      await scripting?.settled();
      player.tick();
      if (uncaught.length > 0) {
        throw uncaught[0];
      }
    }

    return { lines: trace.length, codegen: codegenMemory?.buffer.byteLength ?? 0, error: null };
  } catch (e) {
    return { lines: trace.length, codegen: 0, error: describe(e, scripting) };
  }
}

/** What the SWF openSwf started has traced. */
async function traceSwf(): Promise<string[]> {
  return opened?.trace ?? [];
}

/** Let go of the SWF openSwf started. */
async function closeSwf(): Promise<boolean> {
  opened = null;
  return true;
}

const page = globalThis as unknown as {
  runSwf: typeof runSwf;
  benchSwf: typeof benchSwf;
  openSwf: typeof openSwf;
  stepSwf: typeof stepSwf;
  closeSwf: typeof closeSwf;
  traceSwf: typeof traceSwf;
};
page.runSwf = runSwf;
page.benchSwf = benchSwf;
page.openSwf = openSwf;
page.stepSwf = stepSwf;
page.closeSwf = closeSwf;
page.traceSwf = traceSwf;
