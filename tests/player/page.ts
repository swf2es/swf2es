// The test page: plays a SWF in the player, frame by frame, and gives back
// the frames asked for as PNG data URLs (runSwf), or how long each frame
// took (benchSwf), scripts and all. chrome.ts calls both.
//
// Flash anti-aliases by supersampling on a grid, none at low quality, 2×2
// at medium and 4×4 at high and best, so the page draws at that many times
// the resolution, without multisampling, and averages each block of
// samples into a pixel.
import { createCodegen } from "@swf2es/codegen";
import { isAs3, readSwf, tags } from "@swf2es/format";
import { PixiView, Player, Scripting } from "@swf2es/player";
import { autoDetectRenderer } from "pixi.js";

interface Run {
  images: Record<number, string>;
  /** What the SWF's scripts traced, a line each. */
  trace: string[];
  error: string | null;
}

/** The scripting for `bytes`, through the served codegen and libraries; null for a SWF with no scripts. `url` is the SWF's, for what it loads. */
async function scriptingFor(
  bytes: Uint8Array,
  trace: string[],
  url: string | null,
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
): Promise<Run> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const images: Record<number, string> = {};
  const trace: string[] = [];
  let scripting: Scripting | null = null;
  try {
    scripting = await scriptingFor(bytes, trace, url);
    const player = new Player(bytes, scripting);
    const n = GRID[quality] ?? 4;
    const renderer = await autoDetectRenderer({
      preference: "webgl",
      width: player.width,
      height: player.height,
      background: player.background,
      antialias: false,
      preserveDrawingBuffer: true,
      resolution: n,
      // Blend modes read what is below them from it (pixi-blend.ts).
      useBackBuffer: true,
    });
    const samples = document.createElement("canvas");
    samples.width = renderer.canvas.width;
    samples.height = renderer.canvas.height;
    const output = document.createElement("canvas");
    output.width = player.width;
    output.height = player.height;
    document.body.replaceChildren(output);
    const view = new PixiView(renderer);
    // BitmapData.draw of a display object renders with it, from the document class on.
    if (scripting) {
      scripting.drawer = view;
    }

    await player.start();
    for (let frame = 1; frame <= frames; frame++) {
      if (frame > 1) {
        // What a frame asked to load is linked between frames, as in a browser's.
        await scripting?.settled();
        player.tick();
      }

      if (capture.includes(frame)) {
        view.render(player.root);
        samples.getContext("2d")?.drawImage(renderer.canvas, 0, 0);
        downsample(samples, output, n);
        images[frame] = output.toDataURL("image/png");
      }
    }

    renderer.destroy();
    return { images, trace, error: null };
  } catch (e) {
    return { images, trace, error: describe(e, scripting) };
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
  tick: number[];
  sync: number[];
  /** Pixi's part of the draw: its instructions and batches, and the GL calls issued. */
  draw: number[];
  /** GL's part: the wait for what was issued to finish. */
  gl: number[];
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
 */
async function benchSwf(base64: string, frames: number, backBuffer = false): Promise<Bench> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const tick: number[] = [];
  const sync: number[] = [];
  const draw: number[] = [];
  const finished: number[] = [];
  let name = "";
  try {
    const start = performance.now();
    // A scripted SWF's scripts run in the tick, which their time is part of.
    const scripting = await scriptingFor(bytes, [], null);
    const player = new Player(bytes, scripting);
    const renderer = await autoDetectRenderer({
      preference: "webgl",
      width: player.width,
      height: player.height,
      background: player.background,
      antialias: false,
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
      if (gl) {
        gl.finish();
      } else if (gpu) {
        await gpu.device.queue.onSubmittedWorkDone();
      }
    };
    view.render(player.root);
    await finish();
    const first = performance.now() - start;
    for (let frame = 2; frame <= frames; frame++) {
      const before = performance.now();
      player.tick();
      const ticked = performance.now();
      view.prepare(player.root);
      const synced = performance.now();
      renderer.render(view.stage);
      const drawn = performance.now();
      await finish();
      tick.push(ticked - before);
      sync.push(synced - ticked);
      draw.push(drawn - synced);
      finished.push(performance.now() - drawn);
    }

    renderer.destroy();
    return { tick, sync, draw, gl: finished, first, renderer: name, error: null };
  } catch (e) {
    return { tick, sync, draw, gl: finished, first: 0, renderer: name, error: describe(e, null) };
  }
}

const page = globalThis as unknown as { runSwf: typeof runSwf; benchSwf: typeof benchSwf };
page.runSwf = runSwf;
page.benchSwf = benchSwf;
