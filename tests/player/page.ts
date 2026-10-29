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
// blends' backdrops and the back buffer alike (the Pixi fork's bounded resolves), before
// the page averages them.
import { createCodegen } from "@swf2es/codegen";
import { isAs3, readActions, readSwf, tags } from "@swf2es/format";
import {
  Avm1,
  Container,
  type DisplayObject,
  type Drawer,
  type FetchRequest,
  type FetchResult,
  type ModuleCache,
  PixiView,
  Player,
  Scripting,
  type SocketHost,
  setTransformTable,
  transformTableDrawn,
} from "@swf2es/player";
import { indexedDbModuleCache } from "@swf2es/player-hosts/indexeddb";
import { precompiledModules } from "@swf2es/player-hosts/precompiled";
import { webWorkerHost } from "@swf2es/player-hosts/workers";
import { autoDetectRenderer } from "pixi.js";
import { type RecordedEvent, Replay } from "./replay.ts";

// Exercise the optional package across the same references and context-loss tests as the default.
const fillOptions = new URLSearchParams(location.search).has("nativeFills")
  ? { fillTessellator: new (await import("@swf2es/native/tessellate")).Tessellator().tessellate }
  : {};
// The renderer of swf2es's own in place of Pixi (SWF2ES_RENDERER=own, chrome.ts): the reference
// cases, and the bench (benchSwf), which draw-counts.ts counts.
const ownRenderer = new URLSearchParams(location.search).has("own");
const bitmapKernel = new URLSearchParams(location.search).has("nativeBitmaps")
  ? new (await import("@swf2es/native/bitmap")).Convolver()
  : null;

// The player's own playerglobal, or Flash Player's under SWF2ES_PLAYERGLOBAL=adobe
// (chrome.ts, libraries.ts).
const LIBRARIES = [
  "builtin",
  new URLSearchParams(location.search).has("adobe") ? "playerglobal-adobe" : "playerglobal-swf2es",
];

// `pnpm test:checked`'s page (chrome.ts): the player checks its own shortcuts too.
if (new URLSearchParams(location.search).has("checked")) {
  Scripting.checkRounds = true;
}

interface Run {
  images: Record<number, string>;
  /** What the SWF's scripts traced, a line each. */
  trace: string[];
  /** The contexts' batches the transform table drew (render/table.ts), in its draw calls. */
  tableDraws: number;
  /** What drew: the renderer's GL, and whether it was WebGL 2, which the table needs. */
  gl: string;
  webGL2: boolean;
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
  moduleCache: ModuleCache | null = null,
  onCompile?: () => void,
  lazyCompilation = false,
): Promise<Scripting | null> {
  const swf = readSwf(bytes);
  if (!isAs3(swf) || !swf.tags.some((t) => t.code === tags.DoABC || t.code === tags.DoABC2)) {
    return null;
  }

  const wasm = await WebAssembly.compileStreaming(fetch("/codegen/codegen.wasm"));
  const codegen = await createCodegen(wasm);
  if (onCompile) {
    const compileModule = codegen.compileModule.bind(codegen);
    const compileModuleLogged = codegen.compileModuleLogged.bind(codegen);
    codegen.compileModule = (hashes, index) => {
      onCompile();
      return compileModule(hashes, index);
    };
    codegen.compileModuleLogged = (hashes, index) => {
      onCompile();
      return compileModuleLogged(hashes, index);
    };
  }

  const scripting = new Scripting(codegen, {
    moduleCache,
    lazyCompilation,
    // A trace of several lines is several lines of Flash's log, which breaks at "\r" as at "\n".
    print: (line) => trace.push(...line.split(/\r|\n/)),
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
    fetch: pageFetch,
    // Background workers on Web Workers, which load the packages as serve.ts resolves them for one.
    workerHost: webWorkerHost({ codegen: wasm, url: "/worker/player-hosts/web-worker.js" }),
  });
  scripting.bitmapConvolver = bitmapKernel?.convolve ?? null;
  const libraries = await Promise.all(
    LIBRARIES.map(async (n) => {
      // A missing library would reach codegen as an empty ABC, rejected as #1107 as if the SWF's.
      const response = await fetch(`/libraries/${n}.abc`);
      if (!response.ok) {
        throw new Error(`no /libraries/${n}.abc: fetch them with libraries.ts's libraryAbcs()`);
      }

      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  await scripting.loadLibraries(libraries);
  return scripting;
}

/** The page's fetch, a test's files served from the corpus as Flash loaded them from disk. */
async function pageFetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
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
}

/** What a socket.json step does: Ruffle's ruffle_socket_format::SocketEvent. */
type SocketStep =
  | { type: "Send"; payload: number[] }
  | { type: "Receive"; expected: number[] }
  | { type: "Disconnect" }
  | { type: "WaitForDisconnect" };

/**
 * A socket host whose every connection opens and then plays `steps`, as
 * Ruffle's test navigator does: a Send the server's bytes, a Receive what
 * the SWF must send next, a Disconnect the server closing. Without steps,
 * a connection never answers, as Ruffle's does without a socket.json.
 */
function scriptedSockets(
  steps: SocketStep[] | null,
  trace: string[],
  logFetch: boolean,
  uncaught: unknown[],
): SocketHost {
  return {
    connect: (host, port, events) => {
      if (logFetch) {
        trace.push("Navigator::connect_socket", `    Host: ${host}; Port: ${port}`);
      }

      const sent: Uint8Array[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const next = () =>
        new Promise<Uint8Array | null>((resolve) => {
          const take = () => {
            if (sent.length > 0) {
              resolve(sent.shift() ?? null);
            } else if (closed) {
              resolve(null);
            } else {
              wake = take;
            }
          };
          take();
        });
      const poke = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      if (steps !== null) {
        void (async () => {
          events.open();
          for (const step of steps) {
            if (closed) {
              return;
            }

            switch (step.type) {
              case "Send":
                events.data(Uint8Array.from(step.payload));
                break;
              case "Disconnect":
                closed = true;
                events.close();
                return;
              case "Receive": {
                const got = await next();
                if (got === null) {
                  return;
                }

                if (got.join() !== step.expected.join()) {
                  uncaught.push(new Error(`socket: expected [${step.expected}], got [${got}]`));
                }

                break;
              }
              case "WaitForDisconnect":
                await next();
                return;
            }
          }
        })();
      }

      return {
        send: (bytes) => {
          sent.push(bytes.slice());
          poke();
        },
        close: () => {
          closed = true;
          poke();
        },
      };
    },
  };
}

let avm1Codegen: Promise<Awaited<ReturnType<typeof createCodegen>>> | null = null;

/**
 * The AVM1 of `bytes`, an AVM1 SWF with actions, through the served
 * codegen; null for any other. Its traces and uncaught errors go where a
 * scripting's do.
 */
async function avm1For(
  bytes: Uint8Array,
  trace: string[],
  uncaught: unknown[],
  url: string | null,
  logFetch: boolean,
  socket: SocketStep[] | null,
): Promise<Avm1 | null> {
  const swf = readSwf(bytes);
  if (isAs3(swf) || readActions(swf).blocks.length === 0) {
    return null;
  }

  // One codegen for every AVM1 SWF the page plays: its actions need no
  // domain, and an instance each would hold a wasm memory each until collected.
  avm1Codegen ??= WebAssembly.compileStreaming(fetch("/codegen/codegen.wasm")).then(createCodegen);
  // Timers and getTimer go by the frames, as the tests step them.
  // Its files are served, but Flash played it from disk: its URL is a file's, its host
  // localhost, at the disk's root as the corpus's outputs show it (`file:///test.swf`), and
  // what it loads beside it.
  const swfUrl = url ? new URL(url, location.href).href : undefined;
  const fileName = swfUrl ? new URL(swfUrl).pathname.split("/").pop() : undefined;
  return new Avm1(await avm1Codegen, {
    print: (line) => trace.push(...line.split(/\r|\n/)),
    onUncaught: (error) => uncaught.push(error),
    realTime: null,
    url: fileName === undefined ? undefined : `file:///${fileName}`,
    base: swfUrl,
    fetch: (request, signal) => {
      if (logFetch) {
        logRequest(request, swfUrl, trace);
      }

      // A test's server at localhost:8000 answers from its localhost/ directory, as Ruffle's
      // test navigator has it; a path it has no file for fails.
      const served = new URL(request.url);
      if (swfUrl && served.host === "localhost:8000") {
        const local = new URL(`localhost${served.pathname}`, swfUrl).href;
        return pageFetch({ ...request, url: local }, signal);
      }

      return pageFetch(request, signal);
    },
    socket: scriptedSockets(socket, trace, logFetch, uncaught),
    // A page is never opened: a test that logs fetches traces it as Ruffle's navigator logs it.
    navigate: logFetch
      ? (url, window, form) => {
          trace.push("Navigator::navigate_to_url:", `  URL: ${url}`, `  Target: ${window}`);
          if (form) {
            trace.push(`  Method: ${form.method}`);
            for (const [name, value] of form.vars) {
              trace.push(`  Param: ${name}=${value}`);
            }
          }
        }
      : null,
  });
}

/**
 * A load traced as Ruffle's test navigator logs a fetch: its URL as the
 * SWF gave it, relative to the SWF's directory, its method and its body.
 */
function logRequest(request: FetchRequest, swfUrl: string | undefined, trace: string[]): void {
  const directory = swfUrl ? swfUrl.slice(0, swfUrl.lastIndexOf("/") + 1) : "";
  const url =
    directory && request.url.startsWith(directory)
      ? request.url.slice(directory.length)
      : request.url;
  trace.push("Navigator::fetch:", `  URL: ${url}`, `  Method: ${request.method}`);
  const type = request.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1];
  const others = request.headers.filter(([name]) => name.toLowerCase() !== "content-type");
  if (others.length > 0) {
    trace.push(`  Headers:`, ...others.map(([name, value]) => `${name}: ${value}`));
  }

  if (request.body) {
    trace.push(`  Mime-Type: ${type ?? ""}`);
    trace.push(
      type === "application/x-www-form-urlencoded"
        ? `  Body: ${new TextDecoder().decode(request.body)}`
        : `  Body: [${[...request.body].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(", ")}]`,
    );
  }
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
  input: RecordedEvent[] | null = null,
  viewport: { width: number; height: number } | null = null,
  logFetch = false,
  socket: SocketStep[] | null = null,
  lazyCompilation = false,
  tablePull?: boolean,
): Promise<Run> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const images: Record<number, string> = {};
  const trace: string[] = [];
  const drawnBefore = transformTableDrawn().draws;
  const tableDraws = () => transformTableDrawn().draws - drawnBefore;
  let gl = "none";
  let webGL2 = false;
  let scripting: Scripting | null = null;
  const uncaught: unknown[] = [];
  // A run ends at the first error nothing caught, after the frame it came in.
  const stopOnUncaught = () => {
    if (uncaught.length > 0) {
      throw uncaught[0];
    }
  };
  try {
    scripting = await scriptingFor(bytes, trace, url, uncaught, null, undefined, lazyCompilation);
    const player = new Player(
      bytes,
      scripting,
      await avm1For(bytes, trace, uncaught, url, logFetch, socket),
    );
    const n = GRID[quality] ?? 4;
    setTransformTable(table, tableMinRun, true, tablePull);
    const shownAt = shown ? zoom : 1;
    player.quality = ["LOW", "MEDIUM", "HIGH", "BEST"][quality] ?? "HIGH";
    // The renderer that draws: Pixi through PixiView, or with ?own the renderer of swf2es's own
    // (docs/renderer.md), which owns its canvas.
    const surface = ownRenderer
      ? await ownSurface(player, n * zoom, shownAt, zoom, antialias)
      : await pixiSurface(player, n * zoom, shownAt, zoom, antialias);
    const context = surface.gl;
    const info = context?.getExtension("WEBGL_debug_renderer_info");
    webGL2 = context instanceof WebGL2RenderingContext;
    gl = context
      ? `${context instanceof WebGL2RenderingContext ? "WebGL 2" : "WebGL 1"}, ${
          info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : "?"
        }`
      : `not WebGL (${surface.name})`;

    const samples = document.createElement("canvas");
    samples.width = surface.canvas.width;
    samples.height = surface.canvas.height;
    const output = document.createElement("canvas");
    output.width = Math.round(player.width * shownAt);
    output.height = Math.round(player.height * shownAt);
    document.body.replaceChildren(output);
    // BitmapData.draw of a display object renders with it, from the document class on.
    if (scripting) {
      scripting.drawer = surface.drawer;
    }

    if (player.avm1) {
      player.avm1.drawer = surface.drawer;
    }

    await player.start();
    stopOnUncaught();
    const replay = input ? new Replay(player, input, viewport) : null;
    for (let frame = 1; frame <= frames; frame++) {
      if (frame > 1) {
        // What a frame asked to load is linked between frames, as in a browser's.
        await scripting?.settled();
        player.tick();
        stopOnUncaught();
      }

      // What an AVM1 frame asked of the network answers after it, as Ruffle's test runner has it.
      if (player.avm1) {
        await player.avm1.settled();
        player.avm1.network();
        stopOnUncaught();
      }

      // Ruffle plays a frame's input after the frame, before it draws.
      if (replay) {
        replay.frame();
        stopOnUncaught();
      }

      if (capture.includes(frame)) {
        surface.render(player.stage);
        // A call GL refused drew nothing, which the picture may not show.
        const glError = surface.gl?.getError();
        if (glError) {
          throw new Error(`GL error 0x${glError.toString(16)} drawing frame ${frame}`);
        }

        samples.getContext("2d")?.drawImage(surface.canvas, 0, 0);
        downsample(samples, output, n);
        images[frame] = output.toDataURL("image/png");
      }
    }

    surface.destroy();
    return { images, trace, tableDraws: tableDraws(), gl, webGL2, error: null };
  } catch (e) {
    return { images, trace, tableDraws: tableDraws(), gl, webGL2, error: describe(e, scripting) };
  }
}

/** What a reference case draws with: its canvas and GL, its drawing of the stage and BitmapData's. */
interface Surface {
  name: string;
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext | WebGL2RenderingContext | undefined;
  drawer: Drawer;
  /** Lines stroked anew and found stroked already, where the view counts them. */
  counts?: { strokeContexts: number; strokeReuses: number };
  render(root: Player["stage"]): void;
  destroy(): void;
}

/** Pixi's renderer at `resolution` canvas pixels a stage pixel, through a PixiView. */
async function pixiSurface(
  player: Player,
  resolution: number,
  shownAt: number,
  zoom: number,
  antialias: boolean,
): Promise<Surface> {
  const renderer = await autoDetectRenderer({
    preference: "webgl",
    width: player.width,
    height: player.height,
    background: player.background,
    antialias,
    preserveDrawingBuffer: true,
    resolution,
    // Blend modes read what is below them from it (render/blend.ts).
    useBackBuffer: true,
  });
  const view = new PixiView(renderer, fillOptions);
  view.quality = player.quality;
  // Drawn n times finer to be averaged down: the screen is the output canvas.
  view.screenScale = shownAt;
  view.stage.scale.set(shownAt / zoom);
  return {
    name: renderer.name,
    canvas: renderer.canvas as HTMLCanvasElement,
    gl: (renderer as unknown as { gl?: WebGLRenderingContext }).gl,
    drawer: view,
    render: (root) => view.render(root),
    destroy: () => renderer.destroy(),
  };
}

/** The renderer of swf2es's own (@swf2es/player/scene), at `resolution`, as pixiSurface shows the stage. */
async function ownSurface(
  player: Player,
  resolution: number,
  shownAt: number,
  zoom: number,
  antialias: boolean,
  preserve = true,
): Promise<Surface> {
  const { RenderView } = await import("@swf2es/player/scene");
  const view = new RenderView({
    width: player.width,
    height: player.height,
    resolution,
    background: player.background,
    // Kept for a read of the frame after it is shown; a bench's frames are read not.
    preserveDrawingBuffer: preserve,
    fillTessellator: fillOptions.fillTessellator,
    // As many samples as a browser's antialiased context takes by default, as pixiSurface's has.
    samples: antialias ? 4 : 1,
  });
  view.quality = player.quality;
  // Drawn n times finer to be averaged down: the screen is the output canvas.
  view.screenScale = shownAt;
  view.scale = shownAt / zoom;
  return {
    name: "own",
    canvas: view.canvas,
    gl: view.gl,
    drawer: view,
    counts: view.counts,
    render: (root) => view.render(root),
    destroy: () => view.destroy(),
  };
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
 * time, buffer uploads and their bytes, program switches, and readbacks. `read` gives
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
    filter: object;
    renderGroup: object;
    graphicsContext: {
      getGpuContext(context: object): { geometryData: { vertices: ArrayLike<number> } };
    };
  };
  const gl = r.gl;
  wrap(gl, "drawElements", () => add("glDraws"));
  wrap(gl, "drawArrays", () => add("glDraws"));
  wrap(gl, "useProgram", () => add("programs"));
  // Stencil masks: state set for each mask drawn and taken off, and the clears.
  for (const method of ["stencilFunc", "stencilOp", "colorMask"]) {
    wrap(gl, method, () => add("stencilState"));
  }
  wrap(gl, "clear", (args) => {
    add("clears");
    if (gl && (args[0] as number) & gl.STENCIL_BUFFER_BIT) {
      add("stencilClears");
    }
  });
  wrap(gl, "texSubImage2D", () => add("texUploads"));
  // Pixels brought back from the GPU, each a wait for it to finish; the
  // bench's own wait, a single pixel, is not the player's.
  wrap(gl, "readPixels", (args) => {
    const pixels = (args[2] as number) * (args[3] as number);
    if (pixels > 1) {
      add("readbacks");
      add("readbackPixels", pixels);
    }
  });
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

  wrap(gl?.getExtension("WEBGL_multi_draw") ?? undefined, "multiDrawElementsWEBGL", () =>
    add("glDraws"),
  );
  // Every draw call, a multi-draw one, as one (calls) and as the draws it makes (subDraws), and
  // the state set between them: what draw-counts.ts holds to its baseline.
  for (const method of [
    "drawElements",
    "drawArrays",
    "drawElementsInstanced",
    "drawArraysInstanced",
  ]) {
    wrap(gl, method, () => {
      add("calls");
      add("subDraws");
    });
  }

  for (const method of [
    "multiDrawArraysWEBGL",
    "multiDrawElementsWEBGL",
    "multiDrawArraysInstancedWEBGL",
    "multiDrawElementsInstancedWEBGL",
  ]) {
    // Each takes the number of draws it makes last.
    wrap(gl?.getExtension("WEBGL_multi_draw") ?? undefined, method, (args) => {
      add("calls");
      add("subDraws", args[args.length - 1] as number);
    });
  }

  wrap(gl, "useProgram", () => add("useProgram"));
  wrap(gl, "bindVertexArray", () => add("bindVertexArray"));
  wrap(gl, "bindFramebuffer", () => add("bindFramebuffer"));
  for (const method in gl) {
    if (/^uniform(\d|Matrix)/.test(method)) {
      wrap(gl, method, () => add("uniforms"));
    }
  }

  // Buffers made anew, and copied on the GPU, as a growing atlas does (render/table.ts).
  wrap(gl, "bufferData", (args) => {
    add("bufferData");
    const data = args[1] as number | ArrayBufferView | null;
    add("bufferDataBytes", typeof data === "number" ? data : (data?.byteLength ?? 0));
  });
  wrap(gl, "copyBufferSubData", (args) => {
    add("copyBufferSubData");
    add("copyBufferSubDataBytes", args[4] as number);
  });

  // A short run's draws, drawn from the atlas a call a draw (render/table.ts): the table's
  // own drawElements, not those of Pixi's pipe for what it leaves to it.
  let inTable = 0;
  let inGraphics = 0;
  const around = (pipe: object | undefined, enter: (by: number) => void) => {
    const object = pipe as Record<string, (...args: unknown[]) => unknown> | undefined;
    const original = object?.execute;
    if (!object || !original) {
      return;
    }

    object.execute = function (this: unknown, ...args: unknown[]) {
      enter(1);
      try {
        return original.apply(this, args);
      } finally {
        enter(-1);
      }
    };
  };
  around(r.renderPipes?.flashTable, (by) => {
    inTable += by;
  });
  around(r.renderPipes?.graphics, (by) => {
    inGraphics += by;
  });
  wrap(gl, "drawElements", () => {
    if (inTable > 0 && inGraphics === 0) {
      add("tableLoopDraws");
    }
  });
  wrap(r.renderPipes?.graphics, "execute", () => add("aloneGraphics"));
  wrap(r.renderPipes?.batch, "execute", () => add("batches"));
  // The most textures a batch drew with: past WebGL 2's least 16 units, a GPU with more would
  // batch what software GL splits.
  wrap(r.renderPipes?.batch, "execute", (args) => {
    const textures = (args[0] as { textures?: { count: number } }).textures?.count ?? 0;
    counts.batchTexturesMost = Math.max(counts.batchTexturesMost ?? 0, textures);
  });
  // A filter's region: the bounds Pixi measures for it each time it draws.
  wrap(r.filter, "_calculateFilterArea", (_, took) => {
    add("filterAreas");
    add("filterAreaMs", took);
  });
  wrap(r.renderGroup, "_buildInstructions", (_, took) => {
    add("rebuilds");
    add("rebuildMs", took);
  });
  // Tessellation: a context Pixi has no GPU data for yet, or one marked dirty, built now. The
  // renderer of swf2es's own has no contexts: its GL calls alone are counted.
  const contexts = r.graphicsContext as unknown as Record<string, unknown> | undefined;
  const update = contexts?.updateGpuContext as ((context: object) => unknown) | undefined;
  if (contexts && update) {
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
  }

  // The table's draw calls and the contexts' batches they drew, whichever way it draws.
  let tableCalls = transformTableDrawn().calls;
  let tableDraws = transformTableDrawn().draws;
  let atlasGrown = transformTableDrawn().grown;
  return {
    read() {
      const out = counts;
      const drawn = transformTableDrawn();
      out.tableRuns = drawn.calls - tableCalls;
      out.tableDraws = drawn.draws - tableDraws;
      out.tableAtlasGrown = drawn.grown - atlasGrown;
      tableCalls = drawn.calls;
      tableDraws = drawn.draws;
      atlasGrown = drawn.grown;
      counts = {};
      return out;
    },
  };
}

/** Chrome's console profiler, which the DOM's types leave out. */
type Profiling = Console & { profile(label: string): void; profileEnd(label: string): void };

/** The first frame a bench profiles, after bench.ts's ten of warm-up and the first. */
const PROFILED_FROM = 12;

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
  pace = 0,
  cpuProfile = false,
  finishEvery = 1,
  hover = false,
  hold = false,
  tableLoop = true,
  clock = false,
  metered = false,
  tablePull?: boolean,
): Promise<Bench> {
  setTransformTable(table, tableMinRun, tableLoop, tablePull);
  // With `clock`, the page's clock stands still but for a frame's time at each tick, so what the
  // player and Pixi keep or let go by age (render groups settling, idle contexts, pools) happens
  // on the same frames however fast the machine draws them (draw-counts.ts).
  const now = performance.now;
  let virtual = performance.now();
  if (clock) {
    performance.now = () => virtual;
  }

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
    // With ?own, the renderer of swf2es's own draws, its walk and draw one step: timed as the
    // draw, the sync none.
    // Its drawing buffer not kept, as Pixi's renderer here keeps none.
    const own = ownRenderer ? await ownSurface(player, 1, 1, 1, antialias, false) : null;
    // Pixi's render groups alone nest; its back buffer the renderer of swf2es's own needs not, as
    // it copies what is behind a blend itself.
    if (own && nestedGroups) {
      throw new Error("--nested-groups benches the Pixi view alone");
    }

    const renderer = own
      ? null
      : await autoDetectRenderer({
          preference: "webgl",
          width: player.width,
          height: player.height,
          background: player.background,
          antialias,
          resolution: 1,
          // As a host that draws blend modes makes it: a full-screen copy a frame.
          useBackBuffer: backBuffer,
        });
    const pixi = renderer ? new PixiView(renderer, fillOptions) : null;
    document.body.replaceChildren(
      own ? own.canvas : (renderer as NonNullable<typeof renderer>).canvas,
    );
    const render = (root: Player["stage"]) => (own ? own.render(root) : pixi?.render(root));
    const drawer = own ? own.drawer : (pixi as PixiView);
    if (scripting) {
      scripting.drawer = drawer;
    }

    if (player.avm1) {
      player.avm1.drawer = drawer;
    }

    await player.start();
    // The mouse over the stage's middle, still, as a user's often is.
    if (hover) {
      player.pointer?.handle("move", { x: player.width / 2, y: player.height / 2 });
    }

    if (uncaught.length > 0) {
      throw uncaught[0];
    }

    // Which renderer drew, the renderer of swf2es's own or which one Pixi chose, and what it draws
    // with; WebGPU when WebGL could not be had, which the output must say.
    const { gl, gpu } = (renderer ?? { gl: own?.gl }) as unknown as {
      gl?: WebGLRenderingContext;
      gpu?: { adapter: { info?: { description?: string; vendor?: string } }; device: GPUDevice };
    };
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    name = gl
      ? `${own ? "own, " : ""}WebGL, ${String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))}`
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
    render(player.stage);
    if (nestedGroups && pixi) {
      const outer = pixi.stage.children[0]?.children[1];
      const inner = outer?.children[1];
      if (!outer || !inner) {
        throw new Error("missing nested benchmark containers");
      }

      outer.enableRenderGroup();
      inner.enableRenderGroup();
      render(player.stage);
    }
    await finish();
    const first = performance.now() - start;
    const heapBefore = heapNow();
    const meters: Record<string, number>[] = [];
    // Only when asked for: each call wrapped and timed would slow the frames timed.
    const counter = metered
      ? meter(renderer ?? { gl })
      : { read: () => ({}) as Record<string, number> };
    const lineCounts = pixi?.counts ?? own?.counts ?? null;
    let stroked = lineCounts?.strokeContexts ?? 0;
    for (let frame = 2; frame <= frames; frame++) {
      // The frames after the bench's warm-up, profiled for chrome.ts to read (--cpu-profile).
      if (cpuProfile && frame === PROFILED_FROM) {
        (console as Profiling).profile("frames");
      }

      const before = performance.now();
      for (const [depth, child] of toggled.entries()) {
        if (Math.floor((frame - 2) / toggleEvery) % 2) {
          player.root.removeChild(child);
        } else {
          player.root.placeAtDepth(child, depth + 1);
        }
      }

      if (clock) {
        virtual += 1000 / player.frameRate;
      }

      player.tick();
      const ticked = performance.now();
      if (uncaught.length > 0) {
        throw uncaught[0];
      }

      pixi?.prepare(player.stage);
      const synced = performance.now();
      if (own) {
        own.render(player.stage);
      } else if (renderer && pixi) {
        renderer.render(pixi.stage);
      }

      const drawn = performance.now();
      // Pipelined, the GPU's work goes on behind the next frames', as a page's does, and only
      // every so many frames is waited for: what the frames take is then the slower of the two.
      if (frame % finishEvery === 0 || frame === frames) {
        await finish();
      }

      tick.push(ticked - before);
      sync.push(synced - ticked);
      draw.push(drawn - synced);
      finished.push(performance.now() - drawn);
      // Lines stroked anew this frame: the Pixi view's contexts, tessellated or not yet.
      const reading = counter.read();
      if (lineCounts) {
        reading.strokeContexts = lineCounts.strokeContexts - stroked;
        stroked = lineCounts.strokeContexts;
      }

      meters.push(reading);
      // Renders no tick came before, as a host that draws on every animation frame does.
      for (let k = 0; k < idleRenders; k++) {
        const begun = performance.now();
        render(player.stage);
        await finish();
        idle.push(performance.now() - begun);
      }

      // Frames apart in time, for what is kept by age to age between them; a task between frames
      // on a still clock, for what the player waits on (a bitmap's decoding) to come in warm-up.
      if (pace > 0 || clock) {
        await new Promise((resolve) => setTimeout(resolve, pace));
      }
    }

    if (cpuProfile) {
      (console as Profiling).profileEnd("frames");
    }

    const counts = lineCounts ? { ...lineCounts } : {};
    const heap: [number, number] = [heapBefore, heapNow()];
    // Everything still held while chrome.ts collects and measures what the frames left (benchHold).
    if (hold) {
      await new Promise<void>((release) => {
        Object.assign(globalThis, { benchRelease: release, benchHeld: true });
      });
    }

    if (own) {
      own.destroy();
    } else {
      renderer?.destroy();
    }

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
  } finally {
    performance.now = now;
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

/**
 * Play a SWF with no scripts a frame for each of `sizes`, the renderer
 * resized before it to that width, height and resolution, as a host
 * fitting the stage to a page that resizes does (resize.ts): what threw,
 * if anything.
 */
/**
 * A player and what draws it, as the context-loss and resize checks drive
 * them: Pixi through a PixiView, or with ?own the renderer of swf2es's own.
 * Its context is lost and given back as Pixi gives it back, once the
 * frames drawn before the next wait are drawn.
 */
interface Drawn {
  player: Player;
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  render(): void;
  loseContext(): void;
  resize(width: number, height: number, resolution?: number): void;
  destroy(): void;
}

async function drawn(bytes: Uint8Array, preserve: boolean): Promise<Drawn> {
  const player = new Player(bytes, null);
  if (ownRenderer) {
    const surface = await ownSurface(player, 1, 1, 1, false, preserve);
    const view = surface.drawer as unknown as {
      resize(width: number, height: number, resolution?: number): void;
    };
    const gl = surface.gl as WebGL2RenderingContext;
    const lose = gl.getExtension("WEBGL_lose_context");
    await player.start();
    return {
      player,
      gl,
      canvas: surface.canvas,
      render: () => surface.render(player.stage),
      loseContext: () => {
        surface.canvas.addEventListener(
          "webglcontextlost",
          () => setTimeout(() => lose?.restoreContext(), 0),
          { once: true },
        );
        lose?.loseContext();
      },
      resize: (width, height, resolution) => view.resize(width, height, resolution),
      destroy: () => surface.destroy(),
    };
  }

  const renderer = await autoDetectRenderer({
    preference: "webgl",
    width: player.width,
    height: player.height,
    background: player.background,
    resolution: 1,
    preserveDrawingBuffer: preserve,
    useBackBuffer: true,
  });
  const view = new PixiView(renderer, fillOptions);
  await player.start();
  return {
    player,
    gl: (renderer as unknown as { gl: WebGL2RenderingContext }).gl,
    canvas: renderer.canvas as HTMLCanvasElement,
    render: () => view.render(player.stage),
    loseContext: () =>
      (renderer as unknown as { context: { forceContextLoss(): void } }).context.forceContextLoss(),
    resize: (width, height, resolution) => renderer.resize(width, height, resolution),
    destroy: () => renderer.destroy(),
  };
}

/** Every pixel of `gl`'s drawing buffer, read back. */
function pixelsOf(gl: WebGL2RenderingContext): Uint8Array {
  const out = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(
    0,
    0,
    gl.drawingBufferWidth,
    gl.drawingBufferHeight,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    out,
  );
  return out;
}

async function resizeSwf(
  base64: string,
  sizes: [number, number, number][],
): Promise<string | null> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const d = await drawn(bytes, false);
  try {
    for (const [width, height, resolution] of sizes) {
      d.resize(width, height, resolution);
      d.player.tick();
      d.render();
    }

    return null;
  } catch (e) {
    return describe(e, null);
  } finally {
    d.destroy();
  }
}

/**
 * Play a SWF with no scripts, through the transform table or with each
 * large context drawn alone, lose the WebGL context and get it back, and
 * draw the same frame again, then play on: the pixels that differ between
 * the two draws, or what threw.
 */
async function contextLossSwf(
  base64: string,
  frames: number,
  table: boolean,
  turned = false,
  tablePull?: boolean,
): Promise<string | null> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  setTransformTable(table, 1, true, tablePull);
  const d = await drawn(bytes, true);
  try {
    for (let i = 0; i < frames; i++) {
      d.player.tick();
      if (turned && i === 0) {
        // Some objects turned in 3D, each drawn from a bitmap of its own (render/three.ts).
        const root = d.player.stage.children[0] as unknown as { children: DisplayObject[] };
        root.children.forEach((child, n) => {
          if (n % 3 === 0) {
            child.set3D("rotationY", 30 + n);
          }
        });
      }

      d.render();
    }

    const before = pixelsOf(d.gl);
    const restored = new Promise((done) =>
      d.canvas.addEventListener("webglcontextrestored", () => setTimeout(done, 0), {
        once: true,
      }),
    );
    d.loseContext();
    await restored;
    const drawnBefore = transformTableDrawn().draws;
    d.render();
    const after = pixelsOf(d.gl);
    let differ = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (
        before[i] !== after[i] ||
        before[i + 1] !== after[i + 1] ||
        before[i + 2] !== after[i + 2] ||
        before[i + 3] !== after[i + 3]
      ) {
        differ++;
      }
    }

    for (let i = 0; i < frames; i++) {
      d.player.tick();
      d.render();
    }

    // The table is Pixi's: the renderer of swf2es's own has none to check.
    if (
      table &&
      !ownRenderer &&
      d.gl instanceof WebGL2RenderingContext &&
      transformTableDrawn().draws === drawnBefore
    ) {
      return "the table drew nothing after the context came back";
    }

    return differ > 0 ? `${differ} of ${before.length / 4} pixels differ` : null;
  } catch (e) {
    return describe(e, null);
  } finally {
    d.destroy();
    setTransformTable(true);
  }
}

/**
 * Play a SWF with no scripts in two renderers at once, one of which loses
 * its WebGL context and gets it back as `plan` says: each `t` plays a
 * frame and draws it in both, `l` loses the context, `r` waits for Pixi to
 * give it back, which it does once the steps between have run, `s`
 * resizes both, and `w` waits past the time after which render groups
 * settle (render/settle.ts), so that the next frame batches what both draw
 * alone. Frames drawn while it is lost are drawn into nothing; every frame
 * drawn with it must match the other renderer's. What first differed, or
 * threw.
 */
async function contextLossPlanSwf(
  base64: string,
  plan: string,
  table: boolean,
  tableMinRun = 1,
  tablePull?: boolean,
): Promise<string | null> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  setTransformTable(table, tableMinRun, true, tablePull);
  const steady = await drawn(bytes, true);
  const losing = await drawn(bytes, true);
  const canvas = losing.canvas;
  const within = (event: Promise<unknown>) =>
    Promise.race([
      event.then(() => true),
      new Promise<boolean>((done) => setTimeout(done, 5000, false)),
    ]);
  let lost = false;
  let wide = false;
  try {
    for (let step = 0; step < plan.length; step++) {
      switch (plan[step]) {
        case "t": {
          // Both scenes represent one frame. GPU work must not let just one cross a settle deadline.
          const now = performance.now;
          const time = performance.now();
          performance.now = () => time;
          try {
            for (const r of [steady, losing]) {
              r.player.tick();
              r.render();
            }
          } finally {
            performance.now = now;
          }

          if (!lost) {
            const a = pixelsOf(steady.gl);
            const b = pixelsOf(losing.gl);
            // The renderer of swf2es's own draws a filtered layer whose kept output was lost with
            // the context as a held layer, reading its passes' targets within a shared page, whose
            // texel coordinates may round a level apart from a texture of its own's: a level, times
            // the strength a glow multiplies it by, 2 at most in context-loss.ts.
            const slack = ownRenderer ? 2 : 0;
            let differ = 0;
            let most = 0;
            for (let i = 0; i < a.length; i++) {
              const by = Math.abs(a[i] - b[i]);
              most = Math.max(most, by);
              if (by > slack) {
                differ++;
              }
            }

            if (differ > 0) {
              return `step ${step} of ${plan}: ${differ} of ${a.length} bytes differ, by ${most} at most`;
            }
          }

          break;
        }

        case "l": {
          const gone = new Promise((done) =>
            canvas.addEventListener("webglcontextlost", done, { once: true }),
          );
          // Given back once the frames drawn till the next await are drawn (drawn()).
          losing.loseContext();
          if (!(await within(gone))) {
            return `step ${step} of ${plan}: the context was not lost`;
          }

          lost = true;
          break;
        }

        case "r": {
          // Registered before anything yields, so the restore Pixi asked for cannot be missed.
          const back = new Promise((done) =>
            canvas.addEventListener("webglcontextrestored", () => setTimeout(done, 0), {
              once: true,
            }),
          );
          if (!(await within(back))) {
            return `step ${step} of ${plan}: the context did not come back`;
          }

          lost = false;
          break;
        }

        case "w": {
          // Past render/settle.ts's SETTLE_MS, 2000, which the player does not export.
          await new Promise((done) => setTimeout(done, 2500));
          break;
        }

        case "s": {
          wide = !wide;
          for (const r of [steady, losing]) {
            r.resize(r.player.width + (wide ? 37 : 0), r.player.height + (wide ? 21 : 0));
          }

          break;
        }
      }
    }

    return null;
  } catch (e) {
    return describe(e, null);
  } finally {
    steady.destroy();
    losing.destroy();
    setTransformTable(true);
  }
}

/** The SWF openSwf started, which stepSwf plays on: for leak.ts, which measures the heap between steps. */
let opened: {
  player: Player;
  scripting: Scripting | null;
  trace: string[];
  uncaught: unknown[];
} | null = null;

/** Start a SWF, with no renderer, for stepSwf to play; any SWF opened before is let go. */
/** The module cache openSwf's players share, made by the first that asks for one (leak.ts --cache). */
let leakCache: ModuleCache | null = null;

async function openSwf(base64: string, url: string | null, cached = false): Promise<string | null> {
  opened = null;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const trace: string[] = [];
  const uncaught: unknown[] = [];
  let scripting: Scripting | null = null;
  try {
    if (cached) {
      leakCache ??= indexedDbModuleCache({ name: `swf2es-leak-${Math.random()}` });
    }

    scripting = await scriptingFor(bytes, trace, url, uncaught, cached ? leakCache : null);
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

/** What moduleCacheSwf found: each load's trace and modules compiled, what eviction kept, and more. */
interface CacheCheck {
  loads: { trace: string[]; compiled: number; error: string | null }[];
  /** The keys left after putting a, b, getting a, then putting c, with room for two. */
  kept: string[];
  /** Whether a module larger than the whole cache was stored. */
  oversized: boolean;
  /** Whether the cache, closed, read a module again; then deleted it. */
  reopened: boolean;
  deleted: boolean;
  /** Whether it wrote and read again once its database was deleted under it. */
  afterVersionChange: boolean;
  /** Whether a database that failed to open was tried again after retryAfter, and only then. */
  retried: boolean;
}

/**
 * The IndexedDB module cache (player-hosts): a SWF played three times with
 * it, the last after its modules were overwritten with half of themselves,
 * which must trace alike, the second compiling nothing; the cache closed
 * and read again; and its eviction of the least recently used, in a small
 * database of its own.
 */
async function moduleCacheSwf(base64: string): Promise<CacheCheck> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const name = `swf2es-test-${Math.random()}`;
  const cache = indexedDbModuleCache({ name });
  const written: string[] = [];
  const keys: string[] = [];
  const watched: ModuleCache = {
    get: (key) => cache.get(key),
    put: async (key, module) => {
      keys.push(key);
      await cache.put(key, module);
      written.push(key);
    },
    delete: (key) => cache.delete(key),
  };
  const loads: CacheCheck["loads"] = [];
  const play = async () => {
    const trace: string[] = [];
    let compiled = 0;
    const uncaught: unknown[] = [];
    let scripting: Scripting | null = null;
    try {
      scripting = await scriptingFor(bytes, trace, null, uncaught, watched, () => compiled++);
      const player = new Player(bytes, scripting);
      await player.start();
      loads.push({
        trace,
        compiled,
        error: uncaught.length ? String(uncaught[0]) : null,
      });
    } catch (e) {
      loads.push({ trace, compiled, error: describe(e, scripting) });
    }
  };
  const stored = async (count: number) => {
    for (let i = 0; i < 300 && written.length < count; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  await play();
  await stored(keys.length);
  await play();
  for (const key of new Set(keys)) {
    const entry = await cache.get(key);
    if (entry) {
      await cache.put(key, { ...entry, module: entry.module.slice(0, entry.module.length / 2) });
    }
  }

  await play();

  // Closed, it opens again.
  cache.close();
  const reopened = (await cache.get(keys[0])) !== undefined;
  await cache.delete(keys[0]);
  const deleted = (await cache.get(keys[0])) === undefined;

  // Room for two modules of 10 characters, 20 bytes each.
  const small = indexedDbModuleCache({ name: `${name}-small`, maxBytes: 40 });
  const ten = (c: string, n = 10) => ({
    module: c.repeat(n),
    log: "",
    lengths: [n, 0] as [number, number],
  });
  await small.put("a", ten("a"));
  await small.put("b", ten("b"));
  // Used later than "b" was put, by the clock's milliseconds.
  await new Promise((r) => setTimeout(r, 20));
  await small.get("a");
  await small.put("c", ten("c"));
  const kept: string[] = [];
  for (const key of ["a", "b", "c"]) {
    if ((await small.get(key)) !== undefined) {
      kept.push(key);
    }
  }

  await small.put("d", ten("d", 30));
  const oversized = (await small.get("d")) !== undefined;

  // Deleted under it, as another tab's upgrade would close it: opened again.
  await new Promise((done) => {
    indexedDB.deleteDatabase(`${name}-small`).onsuccess = done;
  });
  await small.put("e", ten("e"));
  const afterVersionChange = (await small.get("e")) !== undefined;

  // A database that did not open is tried again once `retryAfter` has passed, not before.
  let opens = 0;
  const flaky = {
    open: (n: string, v?: number) => {
      if (++opens === 1) {
        throw new Error("not now");
      }

      return indexedDB.open(n, v);
    },
  } as IDBFactory;
  const later = indexedDbModuleCache({ name: `${name}-later`, indexedDB: flaky, retryAfter: 200 });
  const outcomes: boolean[] = [];
  for (const wait of [0, 0, 300]) {
    await new Promise((r) => setTimeout(r, wait));
    outcomes.push(
      await later.get("x").then(
        () => true,
        () => false,
      ),
    );
  }
  const retried = outcomes.join() === "false,false,true" && opens === 2;

  for (const c of [cache, small, later]) {
    c.close();
  }

  for (const db of [name, `${name}-small`, `${name}-later`]) {
    indexedDB.deleteDatabase(db);
  }

  return { loads, kept, oversized, reopened, deleted, afterVersionChange, retried };
}

/** What precompiledSwf found. */
interface PrecompiledRun {
  trace: string[];
  /** How many modules the player compiled. */
  compiled: number;
  /** Whether the page refused to evaluate code, as a Content-Security-Policy without 'unsafe-eval' has it. */
  evalRefused: boolean;
  /** The last frame drawn, as a PNG data URL, or null where nothing drew. */
  image: string | null;
  error: string | null;
}

/**
 * Pixi's own polyfills for the code it would otherwise build with
 * `new Function`, as pixi.js/unsafe-eval installs them. A bundling host
 * imports that; this page imports the entry tools/pixijs.ts builds of it
 * beside the bundle, which patches the classes the player draws with.
 */
async function pixiWithoutEval(): Promise<void> {
  const polyfills = "/pixi/packages/unsafe-eval.mjs";
  await import(polyfills);
}

/**
 * Play a SWF for `frames` frames from the modules the swf2es command wrote
 * beside `manifest`, imported from their URLs or evaluated, and draw its
 * last frame.
 */
async function precompiledSwf(
  base64: string,
  manifest: string,
  importModules: boolean,
  frames: number,
): Promise<PrecompiledRun> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const trace: string[] = [];
  const uncaught: unknown[] = [];
  let compiled = 0;
  let evalRefused = false;
  // Out of DevTools' call, which lets code evaluate what the page's policy refuses.
  await new Promise((r) => setTimeout(r, 0));
  try {
    new Function("return 1")();
  } catch {
    evalRefused = true;
  }

  let scripting: Scripting | null = null;
  let image: string | null = null;
  try {
    const cache = precompiledModules(manifest, { importModules });
    scripting = await scriptingFor(bytes, trace, null, uncaught, cache, () => compiled++);
    const player = new Player(bytes, scripting);
    await player.start();
    for (let frame = 2; frame <= frames && uncaught.length === 0; frame++) {
      await scripting?.settled();
      player.tick();
    }

    if (uncaught.length > 0) {
      throw uncaught[0];
    }

    if (evalRefused) {
      await pixiWithoutEval();
    }

    const renderer = await autoDetectRenderer({
      preference: "webgl",
      width: player.width,
      height: player.height,
      background: player.background,
      preserveDrawingBuffer: true,
    });
    const view = new PixiView(renderer, fillOptions);
    view.render(player.stage);
    image = renderer.canvas.toDataURL("image/png");
    renderer.destroy();
    return { trace, compiled, evalRefused, image, error: null };
  } catch (e) {
    return { trace, compiled, evalRefused, image, error: describe(e, scripting) };
  }
}

const page = globalThis as unknown as {
  precompiledSwf: typeof precompiledSwf;
  moduleCacheSwf: typeof moduleCacheSwf;
  runSwf: typeof runSwf;
  benchSwf: typeof benchSwf;
  openSwf: typeof openSwf;
  stepSwf: typeof stepSwf;
  closeSwf: typeof closeSwf;
  traceSwf: typeof traceSwf;
  resizeSwf: typeof resizeSwf;
  contextLossSwf: typeof contextLossSwf;
  contextLossPlanSwf: typeof contextLossPlanSwf;
};
page.runSwf = runSwf;
page.precompiledSwf = precompiledSwf;
page.moduleCacheSwf = moduleCacheSwf;
page.benchSwf = benchSwf;
page.openSwf = openSwf;
page.stepSwf = stepSwf;
page.closeSwf = closeSwf;
page.traceSwf = traceSwf;
page.resizeSwf = resizeSwf;
page.contextLossSwf = contextLossSwf;
page.contextLossPlanSwf = contextLossPlanSwf;
