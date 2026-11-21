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
// zoom's inverse, so the same samples come out where the renderer's own
// arithmetic at that resolution decides.
// Or it may have the stage shown at that zoom, as a game's page does: the
// stage drawn at its size at that resolution, the frames the zoom's size.
//
// And it may ask for multisampling, as a host made with `antialias: true`
// draws: the samples are then each resolved from the multisampled targets,
// blends' backdrops and the stage alike, before the page averages them.
import { createCodegen } from "@swf2es/codegen";
import { definesInput, fileAttributes, isAs3, readActions, readSwf, tags } from "@swf2es/format";
import {
  Avm1,
  airLibrary,
  Container,
  type DisplayObject,
  type FetchHost,
  type FetchProgress,
  type FetchRequest,
  type FetchResult,
  type ModuleCache,
  Player,
  responseBytes,
  Scripting,
  type SocketHost,
} from "@swf2es/player";
import { RenderView } from "@swf2es/player/scene";
import { indexedDbModuleCache } from "@swf2es/player-hosts/indexeddb";
import { precompiledModules } from "@swf2es/player-hosts/precompiled";
import { webWorkerHost } from "@swf2es/player-hosts/workers";
import {
  type Commands,
  DRAW,
  type GeometryData,
  MESH,
  PLANE,
  RUN,
  type SceneList,
  SHADED,
  STENCIL_POP,
  STENCIL_PUSH,
} from "@swf2es/render";
import {
  analyseFrame,
  type BlendMemory,
  type Dirtied,
  dirtyMarks,
  FORM_FILL,
  FORM_FRESH,
  FORM_GLYPHS,
  FORM_MESH,
  FORM_NONE,
  FORM_SHADED,
  FORM_SMALL,
  FORM_STAGE,
  type GeometryTally,
  SUB_RUN_INTS,
  walkCensus,
} from "./census.ts";
import { type RecordedEvent, Replay } from "./replay.ts";

/**
 * The native tessellator the renderer draws fills with, as an element's does by default, made as it
 * first needs it.
 */
let nativeFills: import("@swf2es/native/render").Tessellator | null = null;
let timedFills: import("@swf2es/native/render").Tessellator["tessellate"] | null = null;

/** The ms the renderer's layers of fills have taken to tessellate, which benchSwf reads each frame. */
let tessellationMs = 0;

async function fillTessellator(): Promise<
  import("@swf2es/native/render").Tessellator["tessellate"]
> {
  if (!timedFills) {
    nativeFills ??= new (await import("@swf2es/native/render")).Tessellator();
    const fills = nativeFills.tessellate;
    timedFills = Object.assign(
      (contours: readonly (readonly number[])[], nonZero: boolean) => fills(contours, nonZero),
      {
        layer: (...args: Parameters<typeof fills.layer>) => {
          const begun = performance.now();
          try {
            return fills.layer(...args);
          } finally {
            tessellationMs += performance.now() - begun;
          }
        },
        lines: fills.lines,
      },
    );
  }

  return timedFills;
}

// The player's own playerglobal, or Flash Player's under SWF2ES_PLAYERGLOBAL=adobe
// (chrome.ts, libraries.ts).
const LIBRARIES = [
  "builtin",
  new URLSearchParams(location.search).has("adobe") ? "playerglobal-adobe" : "playerglobal-swf2es",
];

// `pnpm test:checked`'s page (chrome.ts): the player checks its own shortcuts too, and every
// view made on the page the spans of its scene list.
if (new URLSearchParams(location.search).has("checked")) {
  Scripting.checkRounds = true;
  Scripting.checkPicks = true;
  RenderView.checkSpans = true;
}

interface Run {
  images: Record<number, string>;
  /** What the SWF's scripts traced, a line each. */
  trace: string[];
  /** What drew: the GL renderer's name. */
  gl: string;
  error: string | null;
}

/** Whether `error` is the player's report of an ErrorEvent no listener heard, Error #2044. */
function unheardEvent(rt: Scripting["rt"], error: unknown): boolean {
  try {
    return rt.getProperty(error as never, rt.publicName("errorID")) === 2044;
  } catch {
    return false;
  }
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
  {
    moduleCache = null,
    onCompile,
    lazyCompilation = false,
    air = false,
    apiVersion = "latest",
    logFetch = false,
    realTime = false,
  }: {
    moduleCache?: ModuleCache | null;
    onCompile?: () => void;
    lazyCompilation?: boolean;
    /** Played as AIR plays it (Scripting's `air`). */
    air?: boolean;
    /** The API version it runs at (Scripting's `apiVersion`), "root" its own SWF version's. */
    apiVersion?: "latest" | "root" | number;
    /** Its fetches traced, for a test with log_fetch (testFetch). */
    logFetch?: boolean;
    /** getTimer and timers by the wall clock, as a benchmark needs, not by the frames. */
    realTime?: boolean;
  } = {},
): Promise<Scripting | null> {
  const swf = readSwf(bytes);
  // As the element: a SWF with no code that defines buttons or fields gets its VM for their input.
  const code = swf.tags.some((t) => t.code === tags.DoABC || t.code === tags.DoABC2);
  if (!isAs3(swf) || !(code || definesInput(swf))) {
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

  // As avm1For: Flash played it from disk, so its URL is a file's at the disk's root
  // (`file:///test.swf`), its host localhost, and the fetch serves what it loads from beside it.
  const swfUrl = url ? new URL(url, location.href) : undefined;
  const fileUrl = swfUrl
    ? `file:///${swfUrl.pathname.split("/").pop()}${swfUrl.search}`
    : undefined;
  const scripting = new Scripting(codegen, {
    moduleCache,
    lazyCompilation,
    air,
    apiVersion,
    swfVersion: swf.header.version,
    // A trace of several lines is several lines of Flash's log, which breaks at "\r" as at "\n".
    print: (line) => trace.push(...line.split(/\r|\n/)),
    // The debugger player, as adl is and as Ruffle's traces were recorded: errors carry their text.
    debugger: true,
    // The frame clock, so that traces that tell getTimer are the same on every run; or the
    // wall clock, the player's own, for a benchmark that times itself by it.
    realTime: realTime ? undefined : null,
    // These corpus traces were recorded on a 1536×864 Flash host.
    screenCapabilities: url?.startsWith("/corpus/")
      ? { screenResolutionX: 1536, screenResolutionY: 864, pixelAspectRatio: 1, screenDPI: 72 }
      : undefined,
    url: fileUrl,
    sandboxType: fileUrl && !air ? localSandbox(bytes) : undefined,
    // A navigateToURL to "_self" would take the page itself away.
    navigate: null,
    // An ErrorEvent no listener heard (#2044) ends no run: Flash tells its debugger of it and
    // plays on, tracing nothing, and a test without a socket or a Context3D has many.
    onUncaught: (error) => {
      if (!unheardEvent(scripting.rt, error)) {
        uncaught.push(error);
      }
    },
    fetch: testFetch(swfUrl?.href, trace, logFetch, true),
    // Background workers on Web Workers, which load the packages as serve.ts resolves them for one.
    workerHost: webWorkerHost({ codegen: wasm, url: "/worker/player-hosts/web-worker.js" }),
  });
  const libraries: Uint8Array[] = await Promise.all(
    LIBRARIES.map(async (n) => {
      // A missing library would reach codegen as an empty ABC, rejected as #1107 as if the SWF's.
      const response = await fetch(`/libraries/${n}.abc`);
      if (!response.ok) {
        throw new Error(`no /libraries/${n}.abc: fetch them with libraries.ts's libraryAbcs()`);
      }

      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  if (air) {
    libraries.push(airLibrary);
  }
  await scripting.loadLibraries(libraries);
  return scripting;
}

/**
 * A test's fetch: logged as Ruffle's test navigator logs it where the test
 * asks (log_fetch), and a test's server at localhost:8000 answering from
 * its localhost/ directory, as that navigator has it; a path it has no
 * file for fails. `later` logs it once the script that asked returns, as
 * Ruffle's AS3 loads start: after the script's own traces.
 */
function testFetch(
  swfUrl: string | undefined,
  trace: string[],
  logFetch: boolean,
  later = false,
): FetchHost {
  return (request, signal, progress) => {
    if (logFetch) {
      if (later) {
        queueMicrotask(() => logRequest(request, swfUrl, trace));
      } else {
        logRequest(request, swfUrl, trace);
      }
    }

    const served = new URL(request.url);
    if (swfUrl && served.host === "localhost:8000") {
      const local = new URL(`localhost${served.pathname}`, swfUrl).href;
      return pageFetch({ ...request, url: local }, signal, progress);
    }

    // What an AVM1 SWF asks of the disk's root, where Flash played it, is served beside it.
    if (swfUrl && served.protocol === "file:") {
      const local = new URL(served.pathname.slice(1) + served.search, swfUrl).href;
      return pageFetch({ ...request, url: local }, signal, progress);
    }

    return pageFetch(request, signal, progress);
  };
}

/** The page's fetch, a test's files served from the corpus as Flash loaded them from disk. */
async function pageFetch(
  request: FetchRequest,
  signal: AbortSignal,
  progress?: FetchProgress,
): Promise<FetchResult> {
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
  const head = { status: local ? 0 : response.status, headers: local ? [] : headers, local };
  // Flash read the corpus's files from disk, each a single read: told as one piece, whatever
  // pieces the browser happens to cut the page server's response into.
  if (local && response.ok && progress) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    progress.open(head, bytes.length);
    progress.data(bytes);
    return { ...head, bytes };
  }

  return { ...head, bytes: response.ok ? await responseBytes(response, head, progress) : null };
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
  if (isAs3(swf) || (readActions(swf).blocks.length === 0 && !definesInput(swf))) {
    return null;
  }

  // One codegen for every AVM1 SWF the page plays: its actions need no
  // domain, and an instance each would hold a wasm memory each until collected.
  avm1Codegen ??= WebAssembly.compileStreaming(fetch("/codegen/codegen.wasm")).then(createCodegen);
  // Timers and getTimer go by the frames, as the tests step them.
  // Its files are served, but Flash played it from disk: its URL is a file's, its host
  // localhost, at the disk's root as the corpus's outputs show it (`file:///test.swf`), its
  // relative URLs against it and what it loads, the fetch serving them from beside it.
  const swfUrl = url ? new URL(url, location.href).href : undefined;
  const fileName = swfUrl ? new URL(swfUrl).pathname.split("/").pop() : undefined;
  return new Avm1(await avm1Codegen, {
    print: (line) => trace.push(...line.split(/\r|\n/)),
    onUncaught: (error) => uncaught.push(error),
    realTime: null,
    url: fileName === undefined ? undefined : `file:///${fileName}`,
    sandboxType: fileName === undefined ? undefined : localSandbox(bytes),
    fetch: testFetch(swfUrl, trace, logFetch),
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
 * The sandbox of a SWF Flash played from disk, as the desktop app chooses
 * it: localWithNetwork if its FileAttributes ask for the network, else
 * localWithFile.
 */
function localSandbox(bytes: Uint8Array): string {
  return fileAttributes(bytes) & 0x01 ? "localWithNetwork" : "localWithFile";
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
      : request.url.startsWith("file:///")
        ? request.url.slice("file:///".length)
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

/** How runSwf plays a SWF: chrome.ts's PlayerJob, as the page takes it, by name. */
interface RunSwfOptions {
  frames: number;
  /** The frames to draw, 1 the first. */
  capture?: number[];
  /** Its stage quality, 0 low to 3 best. */
  quality?: number;
  url?: string | null;
  zoom?: number;
  antialias?: boolean;
  shown?: boolean;
  input?: RecordedEvent[] | null;
  viewport?: { width: number; height: number } | null;
  logFetch?: boolean;
  socket?: SocketStep[] | null;
  lazyCompilation?: boolean;
  /** Played as AIR plays it (Scripting's `air`). */
  air?: boolean;
  /** The API version it runs at (Scripting's `apiVersion`). */
  apiVersion?: "latest" | "root" | number;
  /** Every frame drawn at the stage's size, as a host draws it, and waited for (chrome.ts). */
  draw?: boolean;
  /** getTimer and timers by the wall clock rather than the frames (scriptingFor). */
  realTime?: boolean;
}

async function runSwf(
  base64: string,
  {
    frames,
    capture = [],
    quality = 2,
    url = null,
    zoom = 1,
    antialias = false,
    shown = false,
    input = null,
    viewport = null,
    logFetch = false,
    socket = null,
    lazyCompilation = false,
    air = false,
    apiVersion = "latest",
    draw = false,
    realTime = false,
  }: RunSwfOptions,
): Promise<Run> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const images: Record<number, string> = {};
  const trace: string[] = [];
  let gl = "none";
  let scripting: Scripting | null = null;
  const uncaught: unknown[] = [];
  // A run ends at the first error nothing caught, after the frame it came in.
  const stopOnUncaught = () => {
    if (uncaught.length > 0) {
      throw uncaught[0];
    }
  };
  try {
    scripting = await scriptingFor(bytes, trace, url, uncaught, {
      lazyCompilation,
      air,
      apiVersion,
      logFetch,
      realTime,
    });
    const player = new Player(
      bytes,
      scripting,
      await avm1For(bytes, trace, uncaught, url, logFetch, socket),
    );
    // A host draws a pixel a stage pixel, not the grid of samples a capture averages.
    const n = draw ? 1 : (GRID[quality] ?? 4);
    const shownAt = shown ? zoom : 1;
    player.quality = ["LOW", "MEDIUM", "HIGH", "BEST"][quality] ?? "HIGH";
    const surface = await surfaceFor(player, n * zoom, shownAt, zoom, antialias);
    gl = rendererName(surface.gl);

    const samples = document.createElement("canvas");
    samples.width = surface.canvas.width;
    samples.height = surface.canvas.height;
    const output = document.createElement("canvas");
    output.width = Math.round(player.width * shownAt);
    output.height = Math.round(player.height * shownAt);
    document.body.replaceChildren(output);
    // BitmapData.draw of a display object renders with it, from the document class on.
    if (scripting) {
      scripting.drawer = surface;
    }

    if (player.avm1) {
      player.avm1.drawer = surface;
    }

    await player.start();
    stopOnUncaught();
    const replay = input ? new Replay(player, input, viewport) : null;
    let drawn = -1;
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

      // As the web host draws: a frame that changed nothing drawn is left as it shows.
      let rendered = false;
      if (draw && player.changes !== drawn && !surface.unchanged(player.stage)) {
        rendered = true;
        drawn = player.changes;
        surface.render(player.stage);
        // Chrome's finish returns before the GPU process has drawn; a read waits for it.
        const gl = surface.gl;
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      }

      if (capture.includes(frame)) {
        rendered = true;
        surface.render(player.stage);
        // A call GL refused drew nothing, which the picture may not show.
        const glError = surface.gl.getError();
        if (glError) {
          throw new Error(`GL error 0x${glError.toString(16)} drawing frame ${frame}`);
        }

        samples.getContext("2d")?.drawImage(surface.canvas, 0, 0);
        downsample(samples, output, n);
        images[frame] = output.toDataURL("image/png");
      }

      // As the web host does with a frame it plays and does not draw.
      if (!rendered) {
        player.undrawn();
      }
    }

    // What the last frame asked to load comes after it, as Ruffle's test runner runs a tick's
    // loads before the tick ends; the frames before had theirs as the next began.
    if (scripting) {
      await scripting.settled();
      for (const end of scripting.loads.completeLoads()) {
        end();
      }

      stopOnUncaught();
    }

    surface.destroy();
    return { images, trace, gl, error: null };
  } catch (e) {
    return { images, trace, gl, error: describe(e, scripting) };
  }
}

/** The GL renderer `gl` draws with, by name. */
function rendererName(gl: WebGL2RenderingContext): string {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return `WebGL 2, ${String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))}`;
}

/**
 * The renderer (@swf2es/player/scene) for `player` at `resolution` canvas
 * pixels a stage pixel, the stage drawn at `shownAt` over `zoom`.
 */
async function surfaceFor(
  player: Player,
  resolution: number,
  shownAt: number,
  zoom: number,
  antialias: boolean,
  preserve = true,
  canvas?: HTMLCanvasElement,
): Promise<RenderView> {
  const view = new RenderView({
    canvas,
    width: player.width,
    height: player.height,
    resolution,
    background: player.background,
    // Kept for a read of the frame after it is shown; a bench's frames are read not.
    preserveDrawingBuffer: preserve,
    fillTessellator: await fillTessellator(),
    // As many samples as a browser's antialiased context takes by default.
    samples: antialias ? 4 : 1,
  });
  view.quality = player.quality;
  // The SWF's frame, which starts where its header says.
  view.setViewport(player.originX, player.originY, player.width, player.height);
  // Drawn n times finer to be averaged down: the screen is the output canvas.
  view.screenScale = shownAt;
  view.scale = shownAt / zoom;
  return view;
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
  /** Each frame's census after the first, where asked for: see installCensus. */
  census: Record<string, number>[];
  /** Filled in by chrome.ts from a sampled heap profile, where asked for. */
  allocated: number;
  heap: [number, number];
  tick: number[];
  /** The draw: the walk of the display list, the plan, and the GL calls issued. */
  draw: number[];
  /** GL's part: the wait for what was issued to finish. */
  gl: number[];
  /** The draw's part spent tessellating fills (fillTessellator). */
  tessellation: number[];
  /** Each render after a frame's with no tick between, whole: draw and GL. */
  idle: number[];
  first: number;
  /** The GL renderer that drew: SwiftShader, or a GPU's name. */
  renderer: string;
  error: string | null;
  /** The CPU copies of geometries the view held after the frames: see geometryTally. */
  geometry?: GeometryTally;
  morphs?: {
    requests: number[];
    misses: number[];
    cached: number;
    pathNumbers: number;
  };
}

/** Measure cache work without adding counters to the player's rendering path. */
function morphMetrics(player: Player) {
  const characters = [...player.library.characters.values()].filter((c) => c.type === "morph");
  let requests = 0;
  let misses = 0;
  const seenRequests: number[] = [];
  const seenMisses: number[] = [];
  for (const character of characters) {
    const cache = character.blends;
    const get = cache.get.bind(cache);
    cache.get = (ratio) => {
      requests++;
      const shape = get(ratio);
      if (!shape) {
        misses++;
      }

      return shape;
    };
  }

  return {
    reset() {
      requests = misses = 0;
    },
    frame() {
      seenRequests.push(requests);
      seenMisses.push(misses);
      requests = misses = 0;
    },
    result() {
      let cached = 0;
      const paths = new Set<number[]>();
      for (const character of characters) {
        cached += character.blends.size;
        for (const shape of character.blends.values()) {
          for (const layer of shape.layers) {
            for (const fill of layer.fills) {
              for (const path of fill.contours) {
                paths.add(path);
              }
            }
            for (const stroke of layer.strokes) {
              for (const path of stroke.paths) {
                paths.add(path);
              }
            }
          }
        }
      }

      let pathNumbers = 0;
      for (const path of paths) {
        pathNumbers += path.length;
      }

      return { requests: seenRequests, misses: seenMisses, cached, pathNumbers };
    },
  };
}

/**
 * What GL is asked in a frame, counted by wrapping its calls: draw calls
 * (a multi-draw one call, its draws apart), program, vertex array and
 * framebuffer binds, uniform calls, stencil state and clears, buffer and
 * texture uploads and their bytes, and readbacks. `read` gives the counts
 * since the last read.
 */
function meter(gl: WebGL2RenderingContext): { read(): Record<string, number> } {
  let counts: Record<string, number> = {};
  const add = (key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by;
  };
  const wrap = <T extends object>(
    target: T | null | undefined,
    method: string,
    count: (args: unknown[]) => void,
  ) => {
    const object = target as Record<string, unknown> | null | undefined;
    const original = object?.[method] as ((...args: unknown[]) => unknown) | undefined;
    if (!object || typeof original !== "function") {
      return;
    }

    object[method] = function (this: T, ...args: unknown[]) {
      const out = original.apply(this, args);
      count(args);
      return out;
    };
  };
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

  // Buffers made anew, and copied on the GPU, as a growing geometry atlas does.
  wrap(gl, "bufferData", (args) => {
    add("bufferData");
    const data = args[1] as number | ArrayBufferView | null;
    add("bufferDataBytes", typeof data === "number" ? data : (data?.byteLength ?? 0));
  });
  wrap(gl, "copyBufferSubData", (args) => {
    add("copyBufferSubData");
    add("copyBufferSubDataBytes", args[4] as number);
  });

  return {
    read() {
      const out = counts;
      counts = {};
      return out;
    },
  };
}

/** What the census reads of the atlas's place of a geometry (webgl/atlas.ts, Place). */
interface CensusPlace {
  glyphs: unknown;
  stage: boolean;
  batch: { frame: number } | null;
}

/** A method of one of the renderer's objects, found by name, which a census wraps. */
function censusMethod(
  object: Record<string, unknown>,
  name: string,
): (...args: unknown[]) => unknown {
  const method = object[name];
  if (typeof method !== "function") {
    throw new Error(`the census found no ${name}: the renderer changed, and census.ts with it`);
  }

  return method as (...args: unknown[]) => unknown;
}

/**
 * The geometries `view`'s registry holds and the CPU copies of them it keeps: the bytes of their
 * vertices' arrays and of their indices, and of the distinct buffers those lie in, which is what
 * the arrays keep alive; those of a geometry small enough to be merged (the atlas's Place.batch)
 * and advanced text's glyph quads apart.
 */
function geometryTally(view: RenderView): GeometryTally {
  const registry = censusField<object>(view, "geometries");
  const data = censusField<(GeometryData | null)[]>(registry, "data");
  const tally: GeometryTally = {
    count: 0,
    vertexBytes: 0,
    indexBytes: 0,
    bufferBytes: 0,
    smallBufferBytes: 0,
    glyphBufferBytes: 0,
    ownBytes: 0,
  };
  // The indices the atlas keeps of what it placed (webgl/atlas.ts, Place.local).
  const atlas = censusField<Record<string, unknown>>(censusField<object>(view, "backend"), "atlas");
  for (const place of (atlas.places ?? []) as ({ local?: Uint16Array | Uint32Array } | null)[]) {
    tally.ownBytes += place?.local?.byteLength ?? 0;
  }

  tally.count = censusField<number>(registry, "count");
  const buffers = new Set<ArrayBufferLike>();
  for (const g of data) {
    if (!g) {
      continue;
    }

    const arrays = [g.positions, g.colors, g.texels, g.depths, g.glyphs?.vertices];
    let bytes = 0;
    for (const array of [...arrays, g.indices]) {
      if (array && array.byteLength > 0 && !buffers.has(array.buffer)) {
        buffers.add(array.buffer);
        bytes += array.buffer.byteLength;
      }
    }

    for (const array of arrays) {
      tally.vertexBytes += array?.byteLength ?? 0;
    }

    tally.indexBytes += g.indices?.byteLength ?? 0;
    tally.bufferBytes += bytes;
    if (g.glyphs) {
      tally.glyphBufferBytes += bytes;
    } else if ((g.positions?.length ?? 0) <= 512 && (g.indices?.length ?? 0) <= 1024 && !g.depths) {
      tally.smallBufferBytes += bytes;
    }
  }

  return tally;
}

/** A field of one of the renderer's objects, found by name, which a census reads. */
function censusField<T = unknown>(object: object, name: string): T {
  if (!(name in object)) {
    throw new Error(`the census found no ${name}: the renderer changed, and census.ts with it`);
  }

  return (object as Record<string, unknown>)[name] as T;
}

/**
 * Each frame's census (installCensus), tagged with `at`: the frame of the bench's it was taken in,
 * which its caller sets before each render, so that one left out cannot shift the rest.
 */
interface Census {
  frames: Record<string, number>[];
  at: number;
}

/**
 * The renderer's census (census.ts) of each frame `view` draws from here on, a record a frame: the
 * view's render and walk, the backend's execute, its run gathering, merging, direct blends and
 * backdrop copies, and GL's program and vertex array binds and draws are wrapped, on these objects
 * alone and only when a census is asked for, so that no other frame pays for it. It reads the
 * renderer's private methods and fields by name (censusMethod, censusField), and throws where one
 * is missing rather than count wrong. 3D objects' planes and BitmapData.draw are drawn through the
 * backend's run, not execute, and are not counted.
 */
function installCensus(view: RenderView): Census {
  const census: Census = { frames: [], at: 0 };
  const v = view as unknown as Record<string, unknown>;
  const backend = censusField<Record<string, unknown>>(v, "backend");
  const draws = censusField<Record<string, unknown>>(backend, "draws");
  const batches = censusField<Record<string, unknown>>(draws, "batches");
  const atlas = censusField<object>(backend, "atlas");
  const places = censusField<(CensusPlace | undefined)[]>(atlas, "places");
  const textures = censusField<unknown[]>(censusField<object>(backend, "gpu"), "textures");
  const compositor = censusField<Record<string, unknown>>(backend, "compositor");
  const masks = censusField<Record<string, unknown>>(v, "masks");
  for (const name of ["program", "blendProgram", "mesh", "glyphProgram", "stageProgram"]) {
    censusField(draws, name);
  }

  censusField(draws, "multi");
  censusField(draws, "prepared");
  censusField(draws, "runCount");
  censusField(batches, "vertexArray");
  censusField(atlas, "frame");
  const gl = view.gl;

  // The objects the walk drew, its calls, and the mask walker's.
  let walked = { calls: 0, objects: new Set<Dirtied>(), hidden: 0, masks: 0, copied: 0 };
  const walk = censusMethod(v, "walk");
  // The walks a checked view makes of what it copied, to compare (copySpan), are not the frame's.
  let copying = 0;
  v.walk = function (this: unknown, ...args: unknown[]) {
    if (copying > 0) {
      // Not counted.
    } else if (args[2]) {
      walked.hidden++;
    } else {
      walked.calls++;
      walked.objects.add(args[0] as Dirtied);
    }

    return walk.apply(this, args);
  };
  // An object whose span of the frame before was taken whole (Spans), not walked: none in a build
  // before spans.
  if (typeof v.copySpan === "function") {
    const copySpan = censusMethod(v, "copySpan");
    v.copySpan = function (this: unknown, ...args: unknown[]) {
      walked.calls--;
      walked.objects.delete(args[0] as Dirtied);
      walked.copied++;
      copying++;
      try {
        return copySpan.apply(this, args);
      } finally {
        copying--;
      }
    };
  }

  const walkMask = censusMethod(masks, "walkMask");
  masks.walkMask = function (this: unknown, ...args: unknown[]) {
    walked.masks++;
    return walkMask.apply(this, args);
  };

  // What the frame's execute gathered, then counted.
  let preparing = false;
  let subRuns = new Int32Array(SUB_RUN_INTS * 256);
  let subRunCount = 0;
  const direct = new Set<number>();
  let copies = 0;
  let paths: Record<string, number> = {};
  let counted: Record<string, number> | null = null;
  let memory: BlendMemory | null = null;

  const prepare = censusMethod(draws, "prepare");
  draws.prepare = function (this: unknown, ...args: unknown[]) {
    preparing = true;
    try {
      return prepare.apply(this, args);
    } finally {
      preparing = false;
    }
  };
  const gatherRun = censusMethod(draws, "gatherRun");
  draws.gatherRun = function (this: Record<string, unknown>, ...args: unknown[]) {
    const last = gatherRun.apply(this, args) as number;
    if (preparing) {
      if ((subRunCount + 1) * SUB_RUN_INTS > subRuns.length) {
        const grown = new Int32Array(subRuns.length * 2);
        grown.set(subRuns);
        subRuns = grown;
      }

      const at = subRunCount++ * SUB_RUN_INTS;
      // Its command found once the frame's commands are known.
      subRuns[at] = -1;
      subRuns[at + 1] = args[1] as number;
      subRuns[at + 2] = last;
      subRuns[at + 3] = censusField<number>(this, "runCount");
      subRuns[at + 4] = 0;
      subRuns[at + 5] = args[3] ? 1 : 0;
    }

    return last;
  };
  const merge = censusMethod(batches, "add");
  batches.add = function (this: unknown, ...args: unknown[]) {
    const segment = merge.apply(this, args);
    if (preparing && segment && subRunCount > 0) {
      subRuns[(subRunCount - 1) * SUB_RUN_INTS + 4] = 1;
    }

    return segment;
  };
  const blendDirect = censusMethod(backend, "blendDirect");
  backend.blendDirect = function (this: unknown, ...args: unknown[]) {
    const drawn = blendDirect.apply(this, args);
    if (drawn) {
      direct.add(args[1] as number);
    }

    return drawn;
  };
  const copyBelow = censusMethod(compositor, "copyBelow");
  compositor.copyBelow = function (this: unknown, ...args: unknown[]) {
    const copied = copyBelow.apply(this, args);
    if (copied) {
      copies++;
    }

    return copied;
  };

  // Each sub-draw by how it was drawn: the program in use, and for fills the merged stream's
  // vertex array or another.
  let program = gl.getParameter(gl.CURRENT_PROGRAM) as unknown;
  let vertexArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as unknown;
  const path = (by: number) => {
    const key =
      program === draws.program
        ? vertexArray === batches.vertexArray
          ? "path.merged"
          : "path.single"
        : program === draws.blendProgram
          ? "path.blended"
          : program === draws.mesh
            ? "path.mesh"
            : program === draws.glyphProgram
              ? "path.glyphs"
              : program === draws.stageProgram
                ? "path.stage"
                : "path.other";
    paths[key] = (paths[key] ?? 0) + by;
  };
  const glMethods = gl as unknown as Record<string, unknown>;
  const useProgram = censusMethod(glMethods, "useProgram");
  glMethods.useProgram = function (this: unknown, ...args: unknown[]) {
    program = args[0];
    return useProgram.apply(this, args);
  };
  const bindVertexArray = censusMethod(glMethods, "bindVertexArray");
  glMethods.bindVertexArray = function (this: unknown, ...args: unknown[]) {
    vertexArray = args[0];
    return bindVertexArray.apply(this, args);
  };
  for (const name of [
    "drawElements",
    "drawArrays",
    "drawElementsInstanced",
    "drawArraysInstanced",
  ]) {
    const draw = censusMethod(glMethods, name);
    glMethods[name] = function (this: unknown, ...args: unknown[]) {
      path(1);
      return draw.apply(this, args);
    };
  }

  const multi = gl.getExtension("WEBGL_multi_draw") as Record<string, unknown> | null;
  if (multi) {
    const multiDraw = censusMethod(multi, "multiDrawElementsWEBGL");
    multi.multiDrawElementsWEBGL = function (this: unknown, ...args: unknown[]) {
      paths["path.multi"] = (paths["path.multi"] ?? 0) + (args[6] as number);
      return multiDraw.apply(this, args);
    };
  }

  const execute = censusMethod(backend, "execute");
  backend.execute = function (this: unknown, ...args: unknown[]) {
    subRunCount = 0;
    direct.clear();
    copies = 0;
    paths = {};
    const out = execute.apply(this, args);
    const commands = args[0] as Commands;
    const scene = args[1] as SceneList;
    const rows = args[2] as { data: Float32Array };
    const geometries = args[3] as { box: Float32Array };
    const target = args[7] as { scale: number };
    // A frame drawn without its runs prepared (a run table too large) is left out.
    if (!censusField<boolean>(draws, "prepared")) {
      return out;
    }

    // Each run's command: Draws.prepare gathers them in the commands' order.
    const ops = commands.ops;
    let k = 0;
    for (let s = 0; s < subRunCount; s++) {
      const at = s * SUB_RUN_INTS;
      const first = subRuns[at + 1];
      const stencil = subRuns[at + 5] === 1;
      while (
        k < commands.length &&
        !(
          (stencil
            ? ops[k * 4] === STENCIL_PUSH || ops[k * 4] === STENCIL_POP
            : ops[k * 4] === RUN) &&
          ops[k * 4 + 1] <= first &&
          first < ops[k * 4 + 1] + ops[k * 4 + 2]
        )
      ) {
        k++;
      }

      subRuns[at] = k;
    }

    const frame = censusField<number>(atlas, "frame");
    const form = new Uint8Array(scene.length);
    let checked = false;
    for (let i = 0; i < scene.length; i++) {
      const place = places[scene.geometry[i]];
      if (scene.kind[i] !== DRAW || !place) {
        continue;
      }

      if (!checked) {
        for (const name of ["glyphs", "stage", "batch"]) {
          censusField(place, name);
        }

        checked = true;
      }

      const texture = scene.texture[i];
      const of = place.glyphs
        ? FORM_GLYPHS
        : scene.sampler[i] & (MESH | PLANE)
          ? FORM_MESH
          : scene.sampler[i] & SHADED
            ? FORM_SHADED
            : place.stage
              ? FORM_STAGE
              : texture >= 0 && !textures[texture]
                ? FORM_NONE
                : FORM_FILL;
      form[i] =
        of |
        (place.batch ? FORM_SMALL : 0) |
        (place.batch && place.batch.frame === frame ? FORM_FRESH : 0);
    }

    const analysed = analyseFrame(
      {
        ops,
        commandCount: commands.length,
        params: commands.params,
        kind: scene.kind,
        geometry: scene.geometry,
        row: scene.row,
        texture: scene.texture,
        sampler: scene.sampler,
        form,
        boxes: geometries.box,
        rows: rows.data,
        scale: target.scale,
        multi: censusField(draws, "multi") !== null,
        subRuns,
        subRunCount,
        direct,
      },
      memory,
    );
    memory = analysed.memory;
    counted = { ...analysed.counts, ...paths, copies };
    return out;
  };

  const render = censusMethod(v, "render");
  v.render = function (this: unknown, ...args: unknown[]) {
    const root = args[0] as object;
    for (const name of ["dirty", "descendantsDirty", "children"]) {
      censusField(root, name);
    }

    // Before the walk clears what changed.
    const marks = dirtyMarks(root as Dirtied);
    walked = { calls: 0, objects: new Set(), hidden: 0, masks: 0, copied: 0 };
    counted = null;
    const out = render.apply(this, args);
    // Set by the execute the render called, which the compiler cannot see.
    const frame = counted as Record<string, number> | null;
    if (frame) {
      census.frames.push({ ...frame, ...walkCensus(marks, walked), frame: census.at });
    }

    return out;
  };

  return census;
}

/** Chrome's console profiler, which the DOM's types leave out. */
type Profiling = Console & { profile(label: string): void; profileEnd(label: string): void };

/** The first frame a bench profiles, after bench.ts's ten of warm-up and the first. */
const PROFILED_FROM = 12;

/**
 * Play a SWF for `frames` frames at the stage's own resolution, timing each
 * frame's tick and draw apart. The GPU is waited for, so that what it does
 * counts; Chrome's software GL does it on the CPU anyway, and the result
 * says which drew.
 *
 * `toggle`, from 0, adds as many sprites drawn by Graphics beside the
 * root's children, taking them off and putting them back every `toggleEvery`
 * frames, as a pool's objects and a panel shown and hidden come and go;
 * the toggle counts in the tick. -1 toggles nothing.
 */
async function benchSwf(
  base64: string,
  frames: number,
  idleRenders = 0,
  toggle = -1,
  antialias = false,
  toggleEvery = 1,
  pace = 0,
  cpuProfile = false,
  finishEvery = 1,
  hover = false,
  hold = false,
  clock = false,
  metered = false,
  measureMorphs = false,
  census = false,
): Promise<Bench> {
  // With `clock`, the page's clock stands still but for a frame's time at each tick, so what the
  // player and the renderer keep or let go by age happens on the same frames however fast the
  // machine draws them (draw-counts.ts).
  const now = performance.now;
  let virtual = performance.now();
  if (clock) {
    performance.now = () => virtual;
  }

  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const tick: number[] = [];
  const draw: number[] = [];
  const finished: number[] = [];
  const tessellation: number[] = [];
  const idle: number[] = [];
  let name = "";
  try {
    const start = performance.now();
    // A scripted SWF's scripts run in the tick, which their time is part of.
    const uncaught: unknown[] = [];
    const scripting = await scriptingFor(bytes, [], null, uncaught);
    const player = new Player(bytes, scripting);
    const morphs = measureMorphs ? morphMetrics(player) : null;
    // Its drawing buffer not kept: a bench's frames are read not.
    const view = await surfaceFor(player, 1, 1, 1, antialias, false);
    document.body.replaceChildren(view.canvas);
    if (scripting) {
      scripting.drawer = view;
    }

    if (player.avm1) {
      player.avm1.drawer = view;
    }

    await player.start();
    // The mouse over the stage's middle, still, as a user's often is.
    if (hover) {
      player.pointer?.handle("move", { x: player.width / 2, y: player.height / 2 });
    }

    if (uncaught.length > 0) {
      throw uncaught[0];
    }

    const gl = view.gl;
    name = rendererName(gl);
    // Chrome's finish returns before the GPU process has drawn; a read waits for it.
    const finish = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    const heapNow = () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
      0;
    const toggled = toggle >= 0 ? await toggling(player.root, toggle) : [];
    view.render(player.stage);
    finish();
    const first = performance.now() - start;
    const heapBefore = heapNow();
    const meters: Record<string, number>[] = [];
    // Only when asked for: each call wrapped and timed would slow the frames timed.
    const counter = metered ? meter(gl) : { read: () => ({}) as Record<string, number> };
    // Only when asked for, as the meter: the census wraps the renderer's own methods.
    const censused = census ? installCensus(view) : null;
    const lineCounts = view.counts;
    const nativeCalls = (globalThis as { benchNativeCalls?: { layer: number; lineBuild: number } })
      .benchNativeCalls;
    if (nativeCalls) {
      nativeCalls.layer = nativeCalls.lineBuild = 0;
    }
    morphs?.reset();
    let stroked = lineCounts.strokeContexts;
    tessellationMs = 0;
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

      if (censused) {
        censused.at = frame;
      }

      view.render(player.stage);
      const drawn = performance.now();
      // Pipelined, the GPU's work goes on behind the next frames', as a page's does, and only
      // every so many frames is waited for: what the frames take is then the slower of the two.
      if (frame % finishEvery === 0 || frame === frames) {
        finish();
      }

      tick.push(ticked - before);
      draw.push(drawn - ticked);
      finished.push(performance.now() - drawn);
      // Part of the draw: the frame's fills tessellated.
      tessellation.push(tessellationMs);
      tessellationMs = 0;
      // Lines stroked anew this frame.
      const reading = counter.read();
      morphs?.frame();
      if (nativeCalls) {
        reading.fillCalls = nativeCalls.layer;
        reading.lineCalls = nativeCalls.lineBuild;
        nativeCalls.layer = nativeCalls.lineBuild = 0;
      }
      reading.strokeContexts = lineCounts.strokeContexts - stroked;
      stroked = lineCounts.strokeContexts;
      meters.push(reading);
      // Renders no tick came before, as a host that draws on every animation frame does.
      if (censused) {
        // An idle render's census is no frame's.
        censused.at = -1;
      }

      for (let k = 0; k < idleRenders; k++) {
        const begun = performance.now();
        view.render(player.stage);
        finish();
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

    const counts = { ...lineCounts };
    const heap: [number, number] = [heapBefore, heapNow()];
    const geometry = geometryTally(view);
    // Everything still held while chrome.ts collects and measures what the frames left (benchHold).
    if (hold) {
      await new Promise<void>((release) => {
        Object.assign(globalThis, { benchRelease: release, benchHeld: true });
      });
    }

    view.destroy();
    return {
      counts,
      meters,
      census: censused?.frames ?? [],
      allocated: 0,
      heap,
      tick,
      draw,
      gl: finished,
      tessellation,
      idle,
      first,
      renderer: name,
      error: null,
      geometry,
      ...(morphs ? { morphs: morphs.result() } : {}),
    };
  } catch (e) {
    return {
      counts: {},
      meters: [],
      census: [],
      allocated: 0,
      heap: [0, 0],
      tick,
      draw,
      gl: finished,
      tessellation,
      idle,
      first: 0,
      renderer: name,
      error: describe(e, null),
    };
  } finally {
    performance.now = now;
  }
}

/** A step of playSwf: an animation frame's call to the player and its draw. */
interface PlayedStep {
  /** The animation frame's time, from the first's, in ms. */
  at: number;
  /** When its work began, in ms from the profile's start where one is taken. */
  begun: number;
  /** How many of the SWF's frames the call played, and how many had played before it. */
  frames: number;
  played: number;
  advance: number;
  draw: number;
  gl: number;
  /** What the renderer asked of GL in it (firstUses), and morph shapes blended for a new ratio. */
  work: Record<string, number>;
}

interface Played {
  steps: PlayedStep[];
  /** From the player's construction to its first frame drawn, and the renderer's making. */
  first: number;
  renderer: number;
  frameRate: number;
  frameCount: number;
  samples: number;
  /** What the renderer asked of GL before the first frame (firstUses). */
  startup: Record<string, number>;
  /** Every program linked, in order: the step it was linked in (-1 before the first) and its ms. */
  links: { step: number; ms: number }[];
  gpu: string;
  /** Whether the context compiles programs in parallel (KHR_parallel_shader_compile). */
  parallel: boolean;
  /** Each frame drawn's census, where asked for: see installCensus. */
  census: Record<string, number>[];
  error: string | null;
}

/**
 * What the renderer asks of GL that a frame may stall on, counted between
 * reads: programs linked and the ms spent compiling, linking and reading
 * their status (where Chrome waits for its GPU process), programs drawn
 * with for the first time (where a driver may build what it put off),
 * buffers made and copied, texture uploads and their bytes, filter passes (and compositeOver: a
 * triangle over the output) and layers composited. Each link goes to
 * `links` with the step it was made in, `step` as it is read.
 */
function firstUses(links: { step: number; ms: number }[]): {
  watch(gl: WebGL2RenderingContext): void;
  read(next: number): Record<string, number>;
} {
  let work: Record<string, number> = {};
  let step = -1;
  const add = (key: string, by = 1) => {
    work[key] = (work[key] ?? 0) + by;
  };
  // On the prototype, so that what the renderer links as it is made counts too.
  const gl = WebGL2RenderingContext;
  const target = gl.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const wrap = (
    object: Record<string, unknown> | null,
    method: string,
    before: (args: unknown[]) => void,
  ) => {
    const original = object?.[method] as ((...args: unknown[]) => unknown) | undefined;
    if (!object || !original) {
      return;
    }

    object[method] = function (this: unknown, ...args: unknown[]) {
      before(args);
      return original.apply(this, args);
    };
  };
  // A link is timed from its shaders' compile to its status read, where Chrome waits, by
  // program: programs begun together (at setup, or all at once where links run in parallel)
  // each keep their own time rather than the first status read taking all of it.
  const shaderTimes = new WeakMap<object, number>();
  const programTimes = new WeakMap<object, number>();
  const charge = (times: WeakMap<object, number>, key: unknown, ms: number) => {
    times.set(key as object, (times.get(key as object) ?? 0) + ms);
  };
  const timed = (method: string, after: (ms: number, args: unknown[]) => void) => {
    const original = target[method];
    target[method] = function (this: unknown, ...args: unknown[]) {
      const begun = performance.now();
      const out = original.apply(this, args);
      const ms = performance.now() - begun;
      add("shaderMs", ms);
      after(ms, args);
      return out;
    };
  };
  timed("compileShader", (ms, args) => charge(shaderTimes, args[0], ms));
  timed("getShaderParameter", (ms, args) => charge(shaderTimes, args[0], ms));
  wrap(target, "attachShader", (args) => {
    charge(programTimes, args[0], shaderTimes.get(args[1] as object) ?? 0);
    shaderTimes.delete(args[1] as object);
  });
  timed("linkProgram", (ms, args) => {
    add("links");
    charge(programTimes, args[0], ms);
  });
  timed("getProgramParameter", (ms, args) => {
    charge(programTimes, args[0], ms);
    if (args[1] === gl.LINK_STATUS) {
      links.push({ step, ms: programTimes.get(args[0] as object) ?? 0 });
      programTimes.delete(args[0] as object);
    }
  });
  const used = new WeakSet<object>();
  let current: object | null = null;
  wrap(target, "useProgram", (args) => {
    current = args[0] as object | null;
  });
  const drawn = () => {
    if (current && !used.has(current)) {
      used.add(current);
      add("firstDraws");
    }
  };
  for (const method of ["drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
    wrap(target, method, drawn);
  }
  wrap(target, "drawArrays", (args) => {
    drawn();
    if (args[2] === 3) {
      add("passes");
    } else if (args[2] === 6) {
      add("composites");
    }
  });
  // Buffers made anew and copied on the GPU, as the geometry atlas grows or is packed again.
  wrap(target, "bufferData", (args) => {
    add("buffers");
    const data = args[1] as number | ArrayBufferView | null;
    add("bufferBytes", typeof data === "number" ? data : (data?.byteLength ?? 0));
  });
  wrap(target, "copyBufferSubData", () => add("bufferCopies"));
  for (const method of ["texImage2D", "texSubImage2D", "compressedTexImage2D"]) {
    wrap(target, method, (args) => {
      add("textures");
      const data = args.find((a) => ArrayBuffer.isView(a)) as ArrayBufferView | undefined;
      const image = args.find(
        (a) => typeof a === "object" && a !== null && !ArrayBuffer.isView(a) && "width" in a,
      ) as { width: number; height: number } | undefined;
      add("textureBytes", data?.byteLength ?? (image ? image.width * image.height * 4 : 0));
    });
  }

  return {
    watch(context: WebGL2RenderingContext): void {
      const multi = context.getExtension("WEBGL_multi_draw") as Record<string, unknown> | null;
      for (const method of ["multiDrawArraysWEBGL", "multiDrawElementsWEBGL"]) {
        wrap(multi, method, drawn);
      }
    },
    read(next: number): Record<string, number> {
      const out = work;
      work = {};
      step = next;
      return out;
    },
  };
}

/**
 * A few ms spent where a profile shows it by name: the moment playSwf's steps are timed from,
 * in the profile's own clock (bench.ts, within).
 */
function profileMark(): void {
  const end = performance.now() + 3;
  while (performance.now() < end) {
    // Spinning.
  }
}

/**
 * Play a SWF in real time as the web element plays it (Playback): on every
 * animation frame the player advances by the time since the last, by its
 * own pacing, streamed sound and all, and the stage is drawn when it
 * changed, at `resolution` canvas pixels a stage pixel, with the samples
 * the element takes for the quality. Each step is timed, the GPU waited
 * for, until `frames` of the SWF's frames have played (0: its length).
 */
async function playSwf(
  base64: string,
  frames: number,
  resolution: number,
  cpuProfile = false,
  census = false,
): Promise<Played> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const steps: PlayedStep[] = [];
  const links: { step: number; ms: number }[] = [];
  let gpu = "";
  try {
    const start = performance.now();
    const uncaught: unknown[] = [];
    const scripting = await scriptingFor(bytes, [], null, uncaught);
    const player = new Player(bytes, scripting);
    const morphs = morphMetrics(player);
    const meter = firstUses(links);
    const made = performance.now();
    const view = await surfaceFor(player, 1, 1, 1, false, false);
    const renderer = performance.now() - made;
    view.screenScale = null;
    view.resize(player.width, player.height, resolution);
    view.canvas.style.width = `${player.width}px`;
    document.body.replaceChildren(view.canvas);
    if (scripting) {
      scripting.drawer = view;
    }

    if (player.avm1) {
      player.avm1.drawer = view;
    }

    const gl = view.gl;
    gpu = rendererName(gl);
    const parallel = gl.getSupportedExtensions()?.includes("KHR_parallel_shader_compile") ?? false;
    meter.watch(gl);
    const censused = census ? installCensus(view) : null;
    // As the element's stageSamples: 4 at medium, 8 at high, 16 at best, fewer on a denser canvas.
    const samplesFor = (quality: string) => {
      const samples = quality === "MEDIUM" ? 4 : quality === "HIGH" ? 8 : 16;
      let dense = 4;
      while (dense < samples / (resolution * resolution)) {
        dense *= 2;
      }

      return Math.min(samples, dense);
    };
    let quality = "";
    await player.start();
    if (uncaught.length > 0) {
      throw uncaught[0];
    }

    const finish = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    const length = frames > 0 ? frames : player.swf.frameCount;
    let played = 0;
    let origin = -1;
    let last = -1;
    let first = -1;
    let busy = 0;
    let drawn = -1;
    morphs.reset();
    const startup = meter.read(0);
    if (cpuProfile) {
      (console as Profiling).profile("play");
    }

    const profiled = performance.now();
    if (cpuProfile) {
      profileMark();
    }

    while (played < length) {
      const now = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
      const dt = last < 0 ? 0 : now - last;
      last = now;
      if (origin < 0) {
        origin = now;
      }

      const begun = performance.now();
      const n = player.advance(dt, busy);
      const advanced = performance.now();
      busy = advanced - begun;
      if (uncaught.length > 0) {
        throw uncaught[0];
      }

      if (player.quality !== quality) {
        quality = player.quality;
        view.quality = quality;
        view.samples = samplesFor(quality);
        drawn = -1;
      }

      let rendered = advanced;
      let finished = advanced;
      if (player.changes !== drawn) {
        drawn = player.changes;
        if (!view.unchanged(player.stage)) {
          if (censused) {
            censused.at = steps.length;
          }

          view.render(player.stage);
          rendered = performance.now();
          finish();
          finished = performance.now();
        }
      }

      if (first < 0) {
        first = finished - start;
      }

      morphs.frame();
      steps.push({
        at: now - origin,
        begun: begun - profiled,
        frames: n,
        played,
        advance: advanced - begun,
        draw: rendered - advanced,
        gl: finished - rendered,
        work: meter.read(steps.length + 1),
      });
      played += n;
    }

    if (cpuProfile) {
      (console as Profiling).profileEnd("play");
    }

    const blended = morphs.result().misses;
    for (const [k, step] of steps.entries()) {
      if (blended[k]) {
        step.work.morphs = blended[k];
      }
    }

    view.destroy();
    return {
      steps,
      first,
      renderer,
      frameRate: player.frameRate,
      frameCount: player.swf.frameCount,
      samples: samplesFor(quality),
      startup,
      links,
      gpu,
      parallel,
      census: censused?.frames ?? [],
      error: null,
    };
  } catch (e) {
    return {
      steps,
      first: 0,
      renderer: 0,
      frameRate: 0,
      frameCount: 0,
      samples: 0,
      startup: {},
      links,
      gpu,
      parallel: false,
      census: [],
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

/**
 * Play a SWF with no scripts a frame for each of `sizes`, the renderer
 * resized before it to that width, height and resolution, as a host
 * fitting the stage to a page that resizes does (resize.ts): what threw,
 * if anything.
 */
/**
 * A player and what draws it, as the context-loss and resize checks drive
 * them. Its context is lost with WEBGL_lose_context and given back once the
 * frames drawn before the next wait are drawn.
 */
interface Drawn {
  player: Player;
  view: RenderView;
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  render(): void;
  loseContext(): void;
  resize(width: number, height: number, resolution?: number): void;
  destroy(): void;
}

async function drawn(
  bytes: Uint8Array,
  preserve: boolean,
  canvas?: HTMLCanvasElement,
): Promise<Drawn> {
  const player = new Player(bytes, null);
  const view = await surfaceFor(player, 1, 1, 1, false, preserve, canvas);
  const lose = view.gl.getExtension("WEBGL_lose_context");
  await player.start();
  return {
    player,
    view,
    gl: view.gl,
    canvas: view.canvas,
    render: () => view.render(player.stage),
    loseContext: () => {
      view.canvas.addEventListener(
        "webglcontextlost",
        () => setTimeout(() => lose?.restoreContext(), 0),
        { once: true },
      );
      lose?.loseContext();
    },
    resize: (width, height, resolution) => view.resize(width, height, resolution),
    destroy: () => view.destroy(),
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

/** The geometries the view keeps after `frames` frames of an AVM1 SWF, each played and drawn. */
async function redrawSwf(base64: string, frames: number): Promise<number> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const uncaught: unknown[] = [];
  const player = new Player(bytes, null, await avm1For(bytes, [], uncaught, null, false, null));
  const view = await surfaceFor(player, 1, 1, 1, false, false);
  try {
    await player.start();

    for (let i = 0; i < frames; i++) {
      player.tick();
      view.render(player.stage);
    }

    if (uncaught.length > 0) {
      throw uncaught[0];
    }

    return view.geometryCount;
  } finally {
    view.destroy();
  }
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
 * A SWF with no scripts drawn as a host fitting it to a window draws it, a
 * frame at each resolution, canvas pixels a stage pixel: each frame's
 * pixels, where `capture` asks for them, and the device text's glyphs and
 * runs rasterized by the end of it.
 */
async function deviceTextSwf(
  base64: string,
  resolutions: number[],
  capture: boolean,
): Promise<{ width: number; height: number; pixels: string | null; rasterized: number }[]> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const player = new Player(bytes, null);
  const view = new RenderView({
    width: player.width,
    height: player.height,
    resolution: 1,
    background: player.background,
    preserveDrawingBuffer: true,
    fillTessellator: await fillTessellator(),
    samples: 4,
  });
  view.quality = player.quality;
  const frames = [];
  try {
    await player.start();

    for (const resolution of resolutions) {
      view.resize(player.width, player.height, resolution);
      player.tick();
      view.render(player.stage);
      let pixels: string | null = null;
      if (capture) {
        const data = pixelsOf(view.gl);
        let text = "";
        for (let i = 0; i < data.length; i += 0x8000) {
          text += String.fromCharCode(...data.subarray(i, i + 0x8000));
        }

        pixels = btoa(text);
      }

      frames.push({
        width: view.gl.drawingBufferWidth,
        height: view.gl.drawingBufferHeight,
        pixels,
        rasterized: view.textRasterized,
      });
    }

    return frames;
  } finally {
    view.destroy();
  }
}

/** `text` drawn black on white by the page's own canvas in the CSS `font`, its baseline at `baseline`: its RGBA, top row first. */
function canvasText(
  text: string,
  font: string,
  width: number,
  height: number,
  x: number,
  baseline: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#000000";
  context.font = font;
  context.fillText(text, x, baseline);
  const data = context.getImageData(0, 0, width, height).data;
  let out = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    out += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }

  return btoa(out);
}

/**
 * What is wrong with the context's provoking vertex, or null: where the
 * browser has WEBGL_provoking_vertex it must be the first, which keeps
 * Safari's Metal from rewriting every draw's indices (webgl/backend.ts).
 */
function provokingProblem(gl: WebGL2RenderingContext): string | null {
  const ext = gl.getExtension("WEBGL_provoking_vertex") as {
    readonly FIRST_VERTEX_CONVENTION_WEBGL: number;
    readonly PROVOKING_VERTEX_WEBGL: number;
  } | null;
  if (!ext || gl.getParameter(ext.PROVOKING_VERTEX_WEBGL) === ext.FIRST_VERTEX_CONVENTION_WEBGL) {
    return null;
  }

  return "the last vertex provokes, not the first";
}

/**
 * Play a SWF with no scripts, lose the WebGL context and get it back, and
 * draw the same frame again, then play on: the pixels that differ between
 * the two draws, or what threw. `turned` turns some objects in 3D first.
 */
async function contextLossSwf(
  base64: string,
  frames: number,
  turned = false,
): Promise<string | null> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const d = await drawn(bytes, true);
  try {
    for (let i = 0; i < frames; i++) {
      d.player.tick();
      if (turned && i === 0) {
        // Some objects turned in 3D, each drawn from a bitmap of its own (display/plane.ts).
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
    const provoked = provokingProblem(d.gl);
    if (provoked) {
      return provoked;
    }

    const restored = new Promise((done) =>
      d.canvas.addEventListener("webglcontextrestored", () => setTimeout(done, 0), {
        once: true,
      }),
    );
    d.loseContext();
    await restored;
    d.render();
    const after = pixelsOf(d.gl);
    const provokedAgain = provokingProblem(d.gl);
    if (provokedAgain) {
      return `after the context came back, ${provokedAgain}`;
    }

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

    return differ > 0 ? `${differ} of ${before.length / 4} pixels differ` : null;
  } catch (e) {
    return describe(e, null);
  } finally {
    d.destroy();
  }
}

/**
 * Play a SWF with no scripts in two renderers at once, one of which loses
 * its WebGL context and gets it back as `plan` says: each `t` plays a
 * frame and draws it in both, `l` loses the context, `r` waits for it to
 * come back, which it does once the steps between have run, and `s`
 * resizes both. `k`, `c` and `d` lose it inside the renderer's own work
 * (lossTrap): at its next program link, a frame's or a restore's; there
 * as a GPU process that dies; at its third drawArrays, midway through a
 * frame's filter passes. Frames drawn while it is lost are drawn into
 * nothing; every frame drawn with it must match the other renderer's, and
 * nothing may throw, in a step or in an event's handler. What first
 * differed, or threw.
 */
async function contextLossPlanSwf(base64: string, plan: string): Promise<string | null> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const steady = await drawn(bytes, true);
  const losing = await drawn(bytes, true);
  const canvas = losing.canvas;
  const trap = lossTrap(losing);
  const uncaught = catchUncaught();
  let losses = 0;
  let restores = 0;
  const countLoss = () => losses++;
  const countRestore = () => restores++;
  canvas.addEventListener("webglcontextlost", countLoss);
  canvas.addEventListener("webglcontextrestored", countRestore);
  const within = (event: Promise<unknown>) =>
    Promise.race([
      event.then(() => true),
      new Promise<boolean>((done) => setTimeout(done, 5000, false)),
    ]);
  let lost = false;
  let wide = false;
  try {
    for (let step = 0; step < plan.length; step++) {
      if (uncaught.errors.length > 0) {
        return `before step ${step} of ${plan}: uncaught ${uncaught.errors[0]}`;
      }

      switch (plan[step]) {
        case "t": {
          // Both scenes represent one frame: GPU work must not age what one keeps and not the
          // other.
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
            const differ = framesDiffer(steady.gl, losing.gl);
            if (differ) {
              return `step ${step} of ${plan}: ${differ}`;
            }
          }

          // A GPU process that died is flagged lost a task later, as the next frame comes.
          if (trap.dead) {
            await new Promise((done) => setTimeout(done, 0));
          }

          break;
        }

        case "k":
          trap.arm("link");
          lost = true;
          break;

        case "c":
          trap.arm("crash");
          lost = true;
          break;

        case "d":
          trap.arm("draw");
          lost = true;
          break;

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
          // Back once every loss is restored and none is armed or under way: a loss during a
          // restore is restored again.
          const deadline = performance.now() + 5000;
          while (losing.gl.isContextLost() || trap.waiting || restores < losses || losses === 0) {
            if (performance.now() > deadline) {
              return `step ${step} of ${plan}: the context did not come back (${trap.waiting ? "a loss armed never came" : `${losses} lost, ${restores} restored`})`;
            }

            await new Promise((done) => setTimeout(done, 5));
          }

          await new Promise((done) => setTimeout(done, 0));
          lost = false;
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

    return uncaught.errors.length > 0 ? `after ${plan}: uncaught ${uncaught.errors[0]}` : null;
  } catch (e) {
    return describe(e, null);
  } finally {
    uncaught.release();
    canvas.removeEventListener("webglcontextlost", countLoss);
    canvas.removeEventListener("webglcontextrestored", countRestore);
    steady.destroy();
    losing.destroy();
  }
}

/**
 * Play a SWF with no scripts in two renderers, one made on a context lost
 * already: its frames draw nothing and throw nothing till the context is
 * restored, and then match the other's. What first differed, or threw.
 */
async function contextLostAtStartSwf(base64: string, frames: number): Promise<string | null> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const canvas = document.createElement("canvas");
  // As the view asks for it, which then gets this one.
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    stencil: true,
  }) as WebGL2RenderingContext;
  const lose = gl.getExtension("WEBGL_lose_context") as WEBGL_lose_context;
  // Asked back, as the view asks for its own, which is not there yet to ask.
  const gone = new Promise((done) =>
    canvas.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        done(null);
      },
      { once: true },
    ),
  );
  lose.loseContext();
  await gone;
  const uncaught = catchUncaught();
  const steady = await drawn(bytes, true);
  let losing: Drawn | null = null;
  try {
    losing = await drawn(bytes, true, canvas);
    const both = [steady, losing];
    const play = () => {
      for (const r of both) {
        r.player.tick();
        r.render();
      }
    };
    for (let i = 0; i < frames; i++) {
      play();
    }

    const back = new Promise((done) =>
      canvas.addEventListener("webglcontextrestored", () => setTimeout(done, 0), { once: true }),
    );
    lose.restoreContext();
    const came = await Promise.race([
      back.then(() => true),
      new Promise<boolean>((done) => setTimeout(done, 5000, false)),
    ]);
    if (!came) {
      return "the context did not come back";
    }

    for (let i = 0; i < frames; i++) {
      play();
      const differ = framesDiffer(steady.gl, losing.gl);
      if (differ) {
        return `frame ${i} after the restore: ${differ}`;
      }
    }

    return uncaught.errors.length > 0 ? `uncaught ${uncaught.errors[0]}` : null;
  } catch (e) {
    return describe(e, null);
  } finally {
    uncaught.release();
    steady.destroy();
    losing?.destroy();
  }
}

/**
 * A SWF with no scripts played while a filter pass's program fails to link
 * saying nothing, on a context never lost (lossTrap's `fault`): taken for a
 * loss Chrome has not flagged yet, frames wait, making nothing on the GPU
 * and throwing nothing, while BitmapData drawn on the GPU is read and drawn
 * into as ever; once it has failed so for longer than a loss takes to be
 * flagged, it is the shaders' fault, and a frame that links it again
 * throws it, as before. What went otherwise, or null.
 */
async function shaderFaultSwf(base64: string): Promise<string | null> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const d = await drawn(bytes, true);
  const trap = lossTrap(d);
  const uncaught = catchUncaught();
  const frame = () => {
    d.player.tick();
    d.render();
  };
  // BitmapData drawn into on the GPU, its newest pixels its texture's alone: a triangle of the
  // SWF's, which needs no program a frame has not linked yet.
  const { BitmapStore } = (await import(`${"/player/bitmap/bitmap.js"}`)) as {
    BitmapStore: new (
      width: number,
      height: number,
      transparent: boolean,
      fill: number,
    ) => { getPixel32(x: number, y: number): number };
  };
  const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  const drawnOnGpu = () => {
    // The SWF's second object, an unfiltered triangle in context-loss.ts.
    const triangle = (d.player.stage.children[0] as unknown as Container).children[1];
    const store = new BitmapStore(32, 32, true, 0);
    const done = d.view.drawInto(store as never, triangle, identity, 0, 0, 32, 32, 1);
    return done ? store : null;
  };
  const pixelsOfStore = (store: { getPixel32(x: number, y: number): number }) => {
    const out: number[] = [];
    for (let i = 0; i < 32 * 32; i++) {
      out.push(store.getPixel32(i % 32, Math.floor(i / 32)));
    }

    return out.join();
  };
  try {
    // Its objects placed, nothing drawn yet.
    d.player.tick();
    const expected = drawnOnGpu();
    const kept = drawnOnGpu();
    if (!expected || !kept) {
      return "the BitmapData was not drawn on the GPU";
    }

    const want = pixelsOfStore(expected);
    if (!want.split(",").some((p) => p !== "0")) {
      return "the BitmapData was drawn empty";
    }

    trap.arm("fault");
    // The first frame links the filter passes it draws, the program queue linking nothing ahead
    // till the second: the fault comes inside its draws, and frames wait from the next.
    frame();
    if (trap.failures === 0) {
      return "the first frame linked nothing";
    }

    const made = trap.made;
    for (let i = 0; i < 20; i++) {
      frame();
    }

    if (trap.made !== made) {
      return `${trap.made - made} GL objects made in 20 frames waiting`;
    }

    // Meanwhile, a BitmapData's texture is read and drawn into as ever.
    if (pixelsOfStore(kept) !== want) {
      return "a BitmapData drawn on the GPU lost its pixels while frames waited";
    }

    const late = drawnOnGpu();
    if (!late || pixelsOfStore(late) !== want) {
      return "a BitmapData was not drawn on the GPU while frames waited";
    }

    // Past LinkLosses' grace, 500 ms.
    await new Promise((done) => setTimeout(done, 700));
    const thrown: string[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        frame();
      } catch (e) {
        thrown.push(describe(e, null));
      }
    }

    // The first frame that links it again throws it. Here the frames after take the filtered
    // output the view registered as kept in the frame that threw, link nothing, and throw
    // nothing, as on dev for a failure that says why.
    if (thrown.length === 0 || !thrown.every((t) => t.startsWith("ShaderError"))) {
      return `the frames after threw ${JSON.stringify(thrown)}`;
    }

    if (d.gl.isContextLost()) {
      return "the context was lost";
    }

    return uncaught.errors.length > 0 ? `uncaught ${uncaught.errors[0]}` : null;
  } finally {
    uncaught.release();
    d.destroy();
  }
}

/**
 * What differs between the frames `a` and `b` show, or null. A filtered
 * layer whose kept output was lost with the context is drawn as a held
 * layer, reading its passes' targets within a shared page, whose texel
 * coordinates may round a level apart from a texture of its own's: a
 * level, times the strength a glow multiplies it by, 2 at most in
 * context-loss.ts.
 */
function framesDiffer(a: WebGL2RenderingContext, b: WebGL2RenderingContext): string | null {
  const x = pixelsOf(a);
  const y = pixelsOf(b);
  const slack = 2;
  let differ = 0;
  let most = 0;
  for (let i = 0; i < x.length; i++) {
    const by = Math.abs(x[i] - y[i]);
    most = Math.max(most, by);
    if (by > slack) {
      differ++;
    }
  }

  return differ > 0 ? `${differ} of ${x.length} bytes differ, by ${most} at most` : null;
}

/** Errors thrown where nothing catches them, an event's handler's among them, till released. */
function catchUncaught(): { errors: string[]; release(): void } {
  const errors: string[] = [];
  const thrown = (event: ErrorEvent) => {
    errors.push(describe(event.error ?? event.message, null));
  };
  const rejected = (event: PromiseRejectionEvent) => {
    errors.push(describe(event.reason, null));
  };
  window.addEventListener("error", thrown);
  window.addEventListener("unhandledrejection", rejected);
  return {
    errors,
    release() {
      window.removeEventListener("error", thrown);
      window.removeEventListener("unhandledrejection", rejected);
    },
  };
}

/**
 * Losses of `d`'s context set to come inside the renderer's own work, each
 * armed after the one before comes: `link` at its next program link, flagged lost at once, as
 * WEBGL_lose_context does; `crash` there too, as a GPU process that dies:
 * every status false and every log empty, the context flagged lost only a
 * task later, as Chrome does; `draw` at its third drawArrays from then,
 * midway through a frame's filter passes. Each is restored as `l`'s is.
 * `fault` loses nothing: every program linked from then on fails, saying
 * nothing, on a context never lost.
 * `made` counts the GL objects made besides programs and shaders.
 */
function lossTrap(d: Drawn) {
  const gl = d.gl;
  const proto = Object.getPrototypeOf(gl) as WebGL2RenderingContext;
  const armed: ("link" | "crash" | "draw" | "fault")[] = [];
  let draws = 0;
  let dead = false;
  let made = 0;
  let failures = 0;
  let faulty = false;
  const failing = new WeakSet<WebGLProgram>();
  d.canvas.addEventListener("webglcontextlost", () => {
    dead = false;
  });
  const own = gl as unknown as Record<string, unknown>;
  for (const name of [
    "createTexture",
    "createFramebuffer",
    "createRenderbuffer",
    "createBuffer",
    "createVertexArray",
    "createSampler",
  ]) {
    const create = (proto as unknown as Record<string, () => unknown>)[name];
    own[name] = () => {
      made++;
      return create.call(gl);
    };
  }

  own.linkProgram = (program: WebGLProgram) => {
    if (armed[0] === "fault") {
      armed.shift();
      faulty = true;
    }

    if (faulty) {
      failing.add(program);
    }

    if (armed[0] === "link") {
      armed.shift();
      d.loseContext();
    } else if (armed[0] === "crash") {
      armed.shift();
      dead = true;
      setTimeout(() => d.loseContext(), 0);
    }

    proto.linkProgram.call(gl, program);
  };
  own.drawArrays = (mode: number, first: number, count: number) => {
    if (armed[0] === "draw" && ++draws === 3) {
      armed.shift();
      d.loseContext();
    }

    proto.drawArrays.call(gl, mode, first, count);
  };
  own.getProgramParameter = (program: WebGLProgram, name: number) => {
    if (failing.has(program) && name === gl.LINK_STATUS) {
      failures++;
      return false;
    }

    return dead ? false : proto.getProgramParameter.call(gl, program, name);
  };
  own.getShaderParameter = (shader: WebGLShader, name: number) =>
    dead ? false : proto.getShaderParameter.call(gl, shader, name);
  own.getProgramInfoLog = (program: WebGLProgram) =>
    dead || failing.has(program) ? "" : proto.getProgramInfoLog.call(gl, program);
  own.getShaderInfoLog = (shader: WebGLShader) =>
    dead ? "" : proto.getShaderInfoLog.call(gl, shader);
  return {
    arm(kind: "link" | "crash" | "draw" | "fault") {
      armed.push(kind);
      draws = 0;
    },
    /** Links `fault` failed so far. */
    get failures() {
      return failures;
    },
    /** GL objects made so far, besides programs and shaders. */
    get made() {
      return made;
    },
    /** Whether a crash is under way, the context not yet flagged lost. */
    get dead() {
      return dead;
    },
    /** Whether a loss is armed or under way. */
    get waiting() {
      return armed.length > 0 || dead;
    },
  };
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

async function openSwf(
  base64: string,
  url: string | null,
  cached = false,
  lazyCompilation = false,
): Promise<string | null> {
  opened = null;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const trace: string[] = [];
  const uncaught: unknown[] = [];
  let scripting: Scripting | null = null;
  try {
    if (cached) {
      leakCache ??= indexedDbModuleCache({ name: `swf2es-leak-${Math.random()}` });
    }

    scripting = await scriptingFor(bytes, trace, url, uncaught, {
      moduleCache: cached ? leakCache : null,
      lazyCompilation,
    });
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
 * codegen's memory and what its live ABCs hold of it, and what stopped it.
 */
async function stepSwf(
  lines: number,
  frames: number,
): Promise<{ lines: number; codegen: number; live: number; error: string | null }> {
  if (!opened) {
    return { lines: 0, codegen: 0, live: 0, error: "no SWF is open" };
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

    return {
      lines: trace.length,
      codegen: codegenMemory?.buffer.byteLength ?? 0,
      live: scripting?.codegen.usage().live ?? 0,
      error: null,
    };
  } catch (e) {
    return { lines: trace.length, codegen: 0, live: 0, error: describe(e, scripting) };
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
      scripting = await scriptingFor(bytes, trace, null, uncaught, {
        moduleCache: watched,
        onCompile: () => compiled++,
      });
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
    scripting = await scriptingFor(bytes, trace, null, uncaught, {
      moduleCache: cache,
      onCompile: () => compiled++,
    });
    const player = new Player(bytes, scripting);
    await player.start();
    for (let frame = 2; frame <= frames && uncaught.length === 0; frame++) {
      await scripting?.settled();
      player.tick();
    }

    if (uncaught.length > 0) {
      throw uncaught[0];
    }

    const view = await surfaceFor(player, 1, 1, 1, false);
    view.render(player.stage);
    image = view.canvas.toDataURL("image/png");
    view.destroy();
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
  playSwf: typeof playSwf;
  openSwf: typeof openSwf;
  stepSwf: typeof stepSwf;
  closeSwf: typeof closeSwf;
  traceSwf: typeof traceSwf;
  resizeSwf: typeof resizeSwf;
  redrawSwf: typeof redrawSwf;
  deviceTextSwf: typeof deviceTextSwf;
  canvasText: typeof canvasText;
  contextLossSwf: typeof contextLossSwf;
  contextLossPlanSwf: typeof contextLossPlanSwf;
  contextLostAtStartSwf: typeof contextLostAtStartSwf;
  shaderFaultSwf: typeof shaderFaultSwf;
};
page.runSwf = runSwf;
page.precompiledSwf = precompiledSwf;
page.moduleCacheSwf = moduleCacheSwf;
page.benchSwf = benchSwf;
page.playSwf = playSwf;
page.openSwf = openSwf;
page.stepSwf = stepSwf;
page.closeSwf = closeSwf;
page.traceSwf = traceSwf;
page.resizeSwf = resizeSwf;
page.redrawSwf = redrawSwf;
page.deviceTextSwf = deviceTextSwf;
page.canvasText = canvasText;
page.contextLossSwf = contextLossSwf;
page.contextLossPlanSwf = contextLossPlanSwf;
page.contextLostAtStartSwf = contextLostAtStartSwf;
page.shaderFaultSwf = shaderFaultSwf;
