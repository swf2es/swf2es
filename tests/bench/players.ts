// Times a benchmark's sections in the players a SWF plays in: swf2es and
// Ruffle's web build, each in headless Chrome; AIR's adl without the
// debugger; and Flash Player's Windows projectors, such as 32 and 11.5,
// under Wine. The benchmarks are those that time themselves for avmshell
// (enumeration/Enumeration.as, dictionary/DictionaryAccess.as),
// vector/VectorAccess.as, indexed access to Vectors and Arrays, and as3pb's
// (tests/programs/as3pb), protobuf, AMF3 and JSON encoding, each compiled
// against playerglobal into a SWF whose document class is empty: their
// script runs as it is loaded, its sections tracing their times
// ("time: dense1k-in 120") by the Date or getTimer, which each player keeps
// the same way. Their other lines must be as Flash traces them. And
// drawing (drawing/Drawing.as): scenes of vectors, bitmaps, filters, text
// and redrawn graphics at three loads each, played at 60 frames a second
// on the GPU, swf2es in its browser build's element as a page has it; each
// level's fps and frame times, by getTimer, and memory: what System says,
// and in Chrome its JS heap and its ArrayBuffers apart (wasm's memory is
// there; the GPU's and other processes' nowhere), not to be set against
// Flash's figures. adl, not Flash Player, does not draw them.
//
//   node tests/bench/players.ts [--runs N] [--ruffle DIR] [--flash32 EXE] [--flash11 EXE]
//     [--wine COMMAND] [--only swf2es,ruffle,adl,flash32,flash11] [--json FILE] [--write-swf DIR]
//     [bench...]
//
// DIR is Ruffle's self-hosted web build, unpacked (its ruffle.js inside),
// or RUFFLE names it; without one Ruffle is left out. adl is found as
// oracle/flash.ts finds it. EXE is a projector (flashplayer_32_sa.exe; the
// release one, as the debugger slows it), or FLASH32 and FLASH11 name them;
// each is left out without one. COMMAND runs a Windows program, "wine" by
// default, or WINE names it ("flatpak run --filesystem=home
// org.winehq.Wine"). Chrome draws on the GPU the Vulkan loader gives it; on
// a machine with two, VK_DRIVER_FILES picks one for a session
// (/usr/share/vulkan/icd.d/intel_icd.x86_64.json or nvidia_icd.x86_64.json),
// and the WebGL renderer each drawing ran on is kept with the results. A
// projector draws on the CPU. A release projector traces nowhere, so it opens the
// SWF from a server here, and the SWF, seeing it plays in a projector,
// sends what it traced back to it and quits. --write-swf writes the
// benchmarks' SWFs into DIR and plays none, to open them elsewhere; outside
// a projector they trace, and in one they quit.
//
// The players take turns, in an order that changes each run, so that none
// always runs after another; the table gives each section's median in
// each, and the others against swf2es. --json FILE keeps every run: its
// times and all it traced, as3pb's sizes and ratios too, with the commit,
// the machine, each player's version, and the lines a player traced
// otherwise than Flash.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpus, release, totalmem, type } from "node:os";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runFlash } from "../../oracle/flash.ts";
import { container, runOracle } from "../../oracle/oracle.ts";
import { readSwf, tags } from "../../packages/format/dist/index.js";
import { runPlayer, withPage } from "../player/chrome.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = `${here}out/players`;
const PLAYERS = ["swf2es", "ruffle", "adl", "flash32", "flash11"] as const;
type PlayerName = (typeof PLAYERS)[number];
const DONE = "players: done";
// What each player's Capabilities.version says, traced before DONE.
const VERSION = "players: version ";
// The GPU Chrome drew a drawing with, as WebGL names it, added after DONE.
const RENDERER = "players: renderer ";
// The page's WebGL renderer: the GPU the players' contexts are on, which Chrome may have fallen back from.
const RENDERER_EXPRESSION = `(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const info = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : "none";
})()`;
// A script may run for this long in any of them: the sections run in one
// frame, and the slowest player takes minutes over some benchmarks.
const SCRIPT_SECONDS = 1200;

// Script code before a benchmark's, which traces through playersReport: in a
// projector, which traces nowhere, playersFinish sends the lines to the
// server the SWF came from and quits. Everywhere else it only traces.
const REPORT = `
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.events.SecurityErrorEvent;
import flash.net.URLLoader;
import flash.net.URLRequest;
import flash.net.URLRequestMethod;
import flash.system.Capabilities;
import flash.system.fscommand;

var playersLines:Array = [];
var playersLoader:URLLoader;

// As trace joins them: String(null) is "null", where join would give "".
function playersReport(...parts):void {
  var strings:Array = [];
  for (var i:int = 0; i < parts.length; i++) {
    strings.push(String(parts[i]));
  }

  var line:String = strings.join(" ");
  trace(line);
  playersLines.push(line);
}

function playersFinish():void {
  playersReport(${JSON.stringify(VERSION)} + Capabilities.version);
  playersReport(${JSON.stringify(DONE)});
  if (Capabilities.playerType != "StandAlone") {
    return;
  }

  var request:URLRequest = new URLRequest("report");
  request.method = URLRequestMethod.POST;
  request.data = playersLines.join("\\n");
  playersLoader = new URLLoader();
  var quit:Function = function(event:Event):void {
    fscommand("quit");
  };
  playersLoader.addEventListener(Event.COMPLETE, quit);
  playersLoader.addEventListener(IOErrorEvent.IO_ERROR, quit);
  playersLoader.addEventListener(SecurityErrorEvent.SECURITY_ERROR, quit);
  playersLoader.load(request);
}
`;
const MAIN = "package {\nimport flash.display.Sprite;\npublic class Main extends Sprite {}\n}\n";

interface Bench {
  /**
   * A script's run as it loads, in one frame, timed by its sections; or
   * drawing (drawing/Drawing.as), frames played in real time at 60 a second
   * on the GPU, which adl, not Flash Player, is left out of.
   */
  kind: "script" | "drawing";
  /** The SWF: the benchmark, its document class, and the report. */
  swf(): Uint8Array;
  /** Each section's name and value, in the order traced: milliseconds, or a drawing's measures. */
  sections(lines: string[]): (readonly [string, number])[];
}

/** One of the benchmarks here: a script that times its sections by the Date. */
function script(path: string): Bench {
  return {
    kind: "script",
    swf() {
      const source = readFileSync(`${here}${path}`, "utf8").replace(/\btrace\(/g, "playersReport(");
      const name = `Players${path.replace(/^.*\//, "").replace(/\.as$/, "")}`;
      const abc = compileScripts(
        [{ name, source: `${MAIN}${REPORT}\n${source}\nplayersFinish();\n` }],
        out,
      ).get(name) as Uint8Array;
      return benchSwf(abc, "script");
    },
    sections: (lines) =>
      lines.flatMap((l) => {
        const m = /^time: ([\w-]+) (\d+)$/.exec(l);
        return m ? [[m[1], Number(m[2])] as const] : [];
      }),
  };
}

/** as3pb's benchmark: its library and messages as -in files, in the order avmshell's build lists them. */
const as3pb: Bench = {
  kind: "script",
  swf() {
    const dir = `${root}tests/programs/as3pb/`;
    const sources = readFileSync(`${dir}runtime/test/bench/shell-sources.txt`, "utf8")
      .split("\n")
      // Not avmshell's stand-ins for playerglobal's classes.
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("runtime/test/shell/"));
    mkdirSync(`${out}/sources`, { recursive: true });
    const source = `${out}/sources/PlayersAs3pb.as`;
    writeFileSync(
      source,
      `${MAIN}${REPORT}
import bench.Benchmark;

new Benchmark(function(message:String, measured:Boolean):void {
  playersReport(measured ? "time: " + message : message);
}).run();
playersFinish();
`,
    );
    const [result] = runOracle(
      [
        {
          source,
          name: "PlayersAs3pb",
          ascArgs: [
            "-AS3",
            "-optimize",
            "-inline",
            "-strict",
            ...sources.flatMap((s) => ["-in", relative(root, `${dir}${s}`)]),
          ],
        },
      ],
      out,
      { imports: ["builtin", "playerglobal"], run: false },
    );
    if (!result.compiled) {
      throw new Error(`as3pb did not compile:\n${result.compileLog}`);
    }

    return benchSwf(new Uint8Array(readFileSync(`${out}/PlayersAs3pb.abc`)), "script");
  },
  // "time: AS3PB bytes: 128ms" under "--- Serialize ---" and "--- Deserialize ---";
  // its totals are their sums, and its ratios are worked out from them.
  sections(lines) {
    const found: (readonly [string, number])[] = [];
    let heading = "";
    for (const l of lines) {
      const h = /^--- (.+) ---$/.exec(l);
      if (h) {
        heading = h[1].toLowerCase();
        continue;
      }

      const m = /^time: (.+): (\d+)ms$/.exec(l);
      if (m && (heading === "serialize" || heading === "deserialize")) {
        found.push([`${heading}-${m[1].toLowerCase().replace(/ /g, "-")}`, Number(m[2])]);
      }
    }

    return found;
  },
};

/**
 * Drawing's scenes, each at three loads: a line a level, "frames: vectors-500 fps 59.9 p50 17 ...",
 * and in a browser "memory: vectors-500 heap 1234 buffers 5678" after it (heapAfter).
 */
const drawing: Bench = {
  kind: "drawing",
  swf() {
    const source = readFileSync(`${here}drawing/Drawing.as`, "utf8");
    const abc = compileScripts(
      [{ name: "PlayersDrawing", source: `${source}\n${REPORT}` }],
      out,
    ).get("PlayersDrawing") as Uint8Array;
    return benchSwf(abc, "drawing");
  },
  // Frame times in milliseconds, memory in MB; a player that keeps no memory figure has none.
  sections(lines) {
    const found: (readonly [string, number])[] = [];
    for (const l of lines) {
      const [kind, level, ...pairs] = l.split(" ");
      if (kind !== "frames:" && kind !== "memory:") {
        continue;
      }

      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const value = Number(pairs[i + 1]);
        if (kind === "frames:" && pairs[i] !== "total" && pairs[i] !== "private") {
          found.push([`${level} ${pairs[i]}`, value]);
        } else if (value > 0) {
          found.push([`${level} ${pairs[i]}-mb`, Math.round((value / 2 ** 20) * 10) / 10]);
        }
      }
    }

    return found;
  },
};

/**
 * LZ4 in C (tests/programs/lz4) as Crossbridge builds a SWF of it: gcc as
 * tests/programs/run.ts runs it for avmshell, but -emit-swf, with
 * lz4/Console.as and the report as its console. Its whole run is in its
 * first frame, so the SWF is given room as the others are.
 */
const lz4: Bench = {
  kind: "script",
  swf() {
    const dir = `${out}/lz4`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/Console.as`,
      `${readFileSync(`${here}lz4/Console.as`, "utf8")}\n${REPORT}`,
    );
    const at = relative(root, dir);
    const vendor = "tests/programs/com-lz4-as3/native/vendor";
    const sdk = "/opt/crossbridge/sdk/usr";
    const imports = [
      "builtin",
      "playerglobal",
      "BinaryData",
      "ISpecialFile",
      "IBackingStore",
      "IVFS",
      "InMemoryBackingStore",
      "PlayerKernel",
      "CModule",
    ].flatMap((abc) => ["-import", `${sdk}/lib/${abc}.abc`]);
    const gcc = [
      "-O4",
      "-DNDEBUG",
      "-flto-api=tests/programs/com-lz4-as3/native/exports.txt",
      "-fllvm-opt-opt=-strip",
      "-disable-telemetry",
      `-I${vendor}`,
      "tests/programs/lz4/main.c",
      ...["lz4", "lz4hc", "lz4frame", "xxhash"].map((f) => `${vendor}/${f}.c`),
      `-symbol-abc=${at}/Console.abc`,
      "-emit-swf",
      "-swf-version=18",
      "-swf-size=100x50",
    ];
    writeFileSync(
      `${dir}/build.sh`,
      [
        "set -e",
        `rm -f ${at}/Console.abc ${at}/lz4.swf`,
        `java -jar ${sdk}/lib/asc2.jar -merge -md -AS3 -strict -optimize ${imports.join(" ")} ${at}/Console.as -outdir ${at} -out Console`,
        `${sdk}/bin/gcc ${gcc.join(" ")} -o ${at}/lz4.swf`,
        "",
      ].join("\n"),
    );
    const built = container(undefined, [`${at}/build.sh`]);
    if (built.status !== 0) {
      throw new Error(`lz4 did not build:\n${built.stdout}${built.stderr}`);
    }

    return withScriptLimits(new Uint8Array(readFileSync(`${dir}/lz4.swf`)));
  },
  // "time: prose compress: 12 ms".
  sections: (lines) =>
    lines.flatMap((l) => {
      const m = /^time: (.+): (\d+) ms$/.exec(l);
      return m ? [[m[1].replace(/ /g, "-"), Number(m[2])] as const] : [];
    }),
};

/** A SWF another tool made, with ScriptLimits after its FileAttributes, as benchSwf gives its own. */
function withScriptLimits(file: Uint8Array): Uint8Array {
  const swf = readSwf(file);
  const first = swf.tags[0];
  if (first?.code !== tags.FileAttributes) {
    throw new Error("a SWF that does not start with FileAttributes");
  }

  const at = first.offset + first.length;
  const limits = w.tag(tags.ScriptLimits, scriptLimits());
  const bytes = new Uint8Array(swf.bytes.length + limits.length);
  bytes.set(swf.bytes.subarray(0, at));
  bytes.set(limits, at);
  bytes.set(swf.bytes.subarray(at), at + limits.length);
  // Uncompressed, of its new length.
  bytes.set([0x46, 0x57, 0x53], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length, true);
  return bytes;
}

/** ScriptLimits' body: Flash's deepest recursion, and SCRIPT_SECONDS for a script to run. */
function scriptLimits(): Uint8Array {
  const limits = new Uint8Array(4);
  new DataView(limits.buffer).setUint16(0, 1000, true);
  new DataView(limits.buffer).setUint16(2, SCRIPT_SECONDS, true);
  return limits;
}

const BENCHES: Record<string, Bench> = {
  enumeration: script("enumeration/Enumeration.as"),
  dictionary: script("dictionary/DictionaryAccess.as"),
  vector: script("vector/VectorAccess.as"),
  as3pb,
  lz4,
  drawing,
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: "string", default: "3" },
    ruffle: { type: "string", default: process.env.RUFFLE },
    flash32: { type: "string", default: process.env.FLASH32 },
    flash11: { type: "string", default: process.env.FLASH11 },
    wine: { type: "string", default: process.env.WINE ?? "wine" },
    only: { type: "string", default: PLAYERS.join(",") },
    "write-swf": { type: "string" },
    json: { type: "string" },
  },
});
const runs = Number(values.runs);
const ruffle = values.ruffle ? resolve(values.ruffle) : undefined;
const projectors: Partial<Record<PlayerName, string>> = {
  flash32: values.flash32 && resolve(values.flash32),
  flash11: values.flash11 && resolve(values.flash11),
};
const wine = values.wine.split(/\s+/).filter(Boolean);
const players = values.only
  .split(",")
  .filter((p): p is PlayerName => (PLAYERS as readonly string[]).includes(p))
  .filter((p) => {
    const missing =
      p === "ruffle"
        ? ruffle === undefined && "--ruffle or RUFFLE names its self-hosted web build"
        : p in projectors && projectors[p] === undefined
          ? `--${p} or ${p.toUpperCase()} names its projector`
          : false;
    if (missing) {
      console.log(`${p} left out: ${missing}`);
    }

    return !missing;
  });

if (players.length === 0) {
  console.log(`no players: ${PLAYERS.join(", ")}`);
  process.exit(1);
}

const benches = positionals.length ? positionals : Object.keys(BENCHES);
for (const bench of benches) {
  if (!BENCHES[bench]) {
    console.log(`no benchmark ${bench}: ${Object.keys(BENCHES).join(", ")}`);
    process.exit(1);
  }
}

/**
 * The benchmark as a SWF: its ABC, with room to run. Of version 18, Flash
 * Player 11.5's, for the APIs as3pb uses (JSON is 11's): Flash shows a SWF
 * only those of its version.
 */
function benchSwf(abc: Uint8Array, kind: Bench["kind"]): Uint8Array {
  const drawn = kind === "drawing";
  return w.swf({
    version: 18,
    width: drawn ? 800 : 100,
    height: drawn ? 600 : 50,
    frameRate: drawn ? 60 : 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.tag(tags.ScriptLimits, scriptLimits()),
      w.doAbc(abc, "Main"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

async function playSwf2es(swf: Uint8Array, kind: Bench["kind"]): Promise<string[]> {
  if (kind === "drawing") {
    return playSwf2esLive(swf);
  }

  // A script runs in the first frame; LZ4's from the second, after Crossbridge's preloader.
  const [result] = await runPlayer([{ swf, frames: 4, capture: [] }], {
    timeout: SCRIPT_SECONDS * 1000,
  });
  if (result.error) {
    throw new Error(`swf2es: ${result.error}`);
  }

  return result.trace;
}

/**
 * A level's line from Drawing.as, the page's memory after it, which a SWF in
 * a browser cannot read: the JS heap, and the ArrayBuffers' backing stores
 * apart, where wasm memory is (Ruffle's nearly all). The GPU's is in
 * neither.
 */
function heapAfter(
  line: string,
  send: <R>(method: string, params?: object) => Promise<R>,
): Promise<string> | null {
  const level = /^frames: (\S+)/.exec(line)?.[1];
  if (!level) {
    return null;
  }

  return send<{ usedSize: number; backingStorageSize?: number }>("Runtime.getHeapUsage").then(
    ({ usedSize, backingStorageSize = 0 }) =>
      `memory: ${level} heap ${usedSize} buffers ${backingStorageSize}`,
  );
}

/**
 * The console's lines on the page, the memory after each level's, until
 * DONE, an error, or SCRIPT_SECONDS: the evaluation's timeout does not cover
 * a wait for the console.
 */
function consoleLines(
  listen: (method: string, listener: (params: Record<string, unknown>) => void) => void,
  send: <R>(method: string, params?: object) => Promise<R>,
): Promise<string[]> {
  const lines: string[] = [];
  const heaps: Promise<string>[] = [];
  return new Promise((done, failed) => {
    const timer = setTimeout(
      () => failed(new Error(`no ${DONE} in ${SCRIPT_SECONDS} s`)),
      SCRIPT_SECONDS * 1000,
    );
    listen("Runtime.consoleAPICalled", (params) => {
      if (params.type !== "log") {
        return;
      }

      const args = params.args as { value?: unknown; description?: string }[];
      const line = args.map((arg) => String(arg.value ?? arg.description ?? "")).join(" ");
      lines.push(line);
      const heap = heapAfter(line, send);
      if (heap) {
        heaps.push(heap);
      }

      if (line === DONE) {
        clearTimeout(timer);
        Promise.all(heaps).then((found) => done([...lines, ...found]), failed);
      }
    });
    listen("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails as {
        exception?: { description?: string };
        text: string;
      };
      clearTimeout(timer);
      failed(new Error(details.exception?.description ?? details.text));
    });
  });
}

/** A drawing's lines, and after them the GPU the page drew on. */
async function withRenderer(
  lines: string[],
  evaluate: <R>(expression: string) => Promise<{ value?: R; exception: string | null }>,
): Promise<string[]> {
  const renderer = await evaluate<string>(RENDERER_EXPRESSION);
  return [...lines, `${RENDERER}${renderer.value ?? renderer.exception}`];
}

/**
 * Drawing in swf2es as a page has it: the browser build's <swf2es-player>,
 * playing as the display's frames come, on the GPU. The SWF's traces reach
 * the console.
 */
async function playSwf2esLive(swf: Uint8Array): Promise<string[]> {
  const dist = `${root}packages/swf2es/dist/`;
  if (!existsSync(`${dist}swf2es.js`)) {
    throw new Error(`swf2es: no ${dist}swf2es.js; pnpm build makes it`);
  }

  const dir = `${out}/live/`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}bench.swf`, swf);
  return withPage(
    "runSwf",
    async (evaluate, send, _fresh, listen) => {
      const lines = consoleLines(listen, send);
      const answer = await evaluate(`(async () => {
        await import("/swf2es/swf2es.js");
        document.body.innerHTML =
          '<swf2es-player src="/bench/bench.swf" width="800" height="600"></swf2es-player>';
      })()`);
      if (answer.exception) {
        throw new Error(`swf2es: ${answer.exception}`);
      }

      return withRenderer(await lines, evaluate);
    },
    true,
    {
      timeout: SCRIPT_SECONDS * 1000,
      mounts: [
        ["/swf2es/", dist],
        ["/bench/", dir],
      ],
    },
  );
}

async function playRuffle(swf: Uint8Array, kind: Bench["kind"]): Promise<string[]> {
  const drawn = kind === "drawing";
  return withPage(
    "runSwf",
    async (evaluate, send, _fresh, listen) => {
      // A drawing's lines come by the console too, for the heap after each level.
      const logged = drawn ? consoleLines(listen, send) : null;
      const answer = await evaluate<string[]>(`(async () => {
        await new Promise((loaded, failed) => {
          const script = document.createElement("script");
          script.src = "/ruffle/ruffle.js";
          script.onload = loaded;
          script.onerror = failed;
          document.head.append(script);
        });
        const lines = [];
        let finish;
        const finished = new Promise((f) => (finish = f));
        const player = window.RufflePlayer.newest().createPlayer();
        player.style.cssText = "${drawn ? "width: 800px; height: 600px" : "width: 100px; height: 50px"}";
        document.body.append(player);
        // Set before the load too: the script runs as the first frame does.
        const observe = (line) => {
          lines.push(line);
          ${drawn ? "console.log(line);" : ""}
          if (line === ${JSON.stringify(DONE)}) {
            finish();
          }
        };
        player.ruffle().traceObserver = observe;
        const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(swf).toString("base64"))}), (c) => c.charCodeAt(0));
        await player.ruffle().load({
          data: bytes,
          autoplay: "on",
          unmuteOverlay: "hidden",
          splashScreen: false,
          logLevel: "error",
          maxExecutionDuration: ${SCRIPT_SECONDS},
        });
        player.ruffle().traceObserver = observe;
        await finished;
        player.remove();
        return lines;
      })()`);
      if (answer.exception) {
        throw new Error(`Ruffle: ${answer.exception}`);
      }

      if (!logged) {
        return answer.value as string[];
      }

      return withRenderer(await logged, evaluate);
    },
    drawn,
    { timeout: SCRIPT_SECONDS * 1000, mounts: [["/ruffle/", `${ruffle}/`]] },
  );
}

async function playAdl(swf: Uint8Array): Promise<string[]> {
  const [result] = await runFlash([{ swf, frames: 4, capture: [], alone: true }], 60_000, {
    timed: true,
  });
  if (result.incomplete || result.errors.length) {
    throw new Error(`adl: ${result.incomplete ? "incomplete" : result.errors.join("\n")}`);
  }

  return result.output;
}

/** A projector under Wine: it opens the SWF from a server here, posts its lines back, and quits. */
async function playProjector(player: PlayerName, swf: Uint8Array): Promise<string[]> {
  let reported!: (body: string) => void;
  const report = new Promise<string>((r) => (reported = r));
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/bench.swf") {
      response.writeHead(200, { "content-type": "application/x-shockwave-flash" });
      response.end(swf);
      return;
    }

    if (request.method === "POST" && request.url === "/report") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.end("ok");
        reported(Buffer.concat(chunks).toString("utf8"));
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;

  const [command, ...args] = wine;
  const child = spawn(
    command,
    [...args, projectors[player] as string, `http://127.0.0.1:${port}/bench.swf`],
    {
      env: { ...process.env, WINEDEBUG: "-all" },
      stdio: "ignore",
    },
  );
  const exited = new Promise<null>((r) => child.once("exit", () => r(null)));
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>(
    (r) => (timer = setTimeout(() => r(undefined), SCRIPT_SECONDS * 1000)),
  );
  try {
    const body = await Promise.race([report, exited, expired]);
    if (body === null) {
      throw new Error(`${player} closed before it reported`);
    }

    if (body === undefined) {
      throw new Error(`${player} did not report in ${SCRIPT_SECONDS} s`);
    }

    // It quits once the report is sent; given a while, and stopped if it has not.
    clearTimeout(timer);
    await Promise.race([exited, new Promise((r) => (timer = setTimeout(r, 10_000)))]);
    return body.split("\n");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }

    server.close();
  }
}

const play: Record<PlayerName, (swf: Uint8Array, kind: Bench["kind"]) => Promise<string[]>> = {
  swf2es: playSwf2es,
  ruffle: playRuffle,
  adl: (swf) => playAdl(swf),
  flash32: (swf) => playProjector("flash32", swf),
  flash11: (swf) => playProjector("flash11", swf),
};

// The lines every player must trace alike: not times, a drawing's measures, or the harness's own.
const checked = (lines: string[]) =>
  lines.filter((l) => l && !/^(time|frames|memory|players): /.test(l));
const median = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Only the SWFs, to play elsewhere: DIR/<bench>.swf.
if (values["write-swf"]) {
  const dir = resolve(values["write-swf"]);
  mkdirSync(dir, { recursive: true });
  for (const bench of benches) {
    writeFileSync(`${dir}/${bench}.swf`, BENCHES[bench].swf());
    console.log(`${dir}/${bench}.swf`);
  }

  process.exit(0);
}

// The player's libraries, which its page loads from tests/player/out.
libraryAbcs();

// What --json writes: every run's times, not only their medians, and what they ran on.
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const session = {
  date: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"),
  uncommitted: git("status", "--porcelain").length > 0,
  machine: {
    cpu: cpus()[0]?.model ?? "",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${type()} ${release()}`,
    // Chrome's GPU, where the Vulkan loader is held to one driver: VK_DRIVER_FILES (or the
    // older VK_ICD_FILENAMES) names it, for a machine with two. Each browser player's renderer
    // says which drew.
    vulkanDriver: process.env.VK_DRIVER_FILES ?? process.env.VK_ICD_FILENAMES ?? "",
  },
  runs,
  players: Object.fromEntries(
    players.map((p) => [p, { version: "", ...playerDetails(p) }]),
  ) as Record<PlayerName, { version: string; [detail: string]: string }>,
  benchmarks: {} as Record<
    string,
    {
      times: Partial<Record<PlayerName, Record<string, number[]>>>;
      /** Everything each run traced, in order: as3pb's sizes and ratios as well as its times. */
      output: Partial<Record<PlayerName, string[][]>>;
      /** The player whose lines the others' are held to. */
      reference: PlayerName;
      /** The lines a player traced otherwise than it. */
      differs: Partial<Record<PlayerName, string[]>>;
    }
  >,
};

/** What a player's own version leaves out: the browser it runs in, Ruffle's release, the projector. */
function playerDetails(player: PlayerName): Record<string, string> {
  switch (player) {
    case "swf2es":
      return { browser: chromeVersion() };
    case "ruffle":
      return {
        browser: chromeVersion(),
        release: JSON.parse(readFileSync(`${ruffle}/package.json`, "utf8")).version,
      };
    case "adl":
      return {};
    case "flash32":
    case "flash11":
      return { projector: basename(projectors[player] as string) };
  }
}

function chromeVersion(): string {
  return execFileSync(process.env.CHROME ?? "google-chrome", ["--version"], {
    encoding: "utf8",
  }).trim();
}

for (const bench of benches) {
  const { sections: timed, kind } = BENCHES[bench];
  const swf = BENCHES[bench].swf();
  const playing = kind === "drawing" ? players.filter((p) => p !== "adl") : players;
  if (playing.length < players.length) {
    console.log(`${bench}: adl left out, as it is not Flash Player`);
  }

  const times = new Map<PlayerName, Map<string, number[]>>(playing.map((p) => [p, new Map()]));
  const traced = new Map<PlayerName, string[]>();
  const output = new Map<PlayerName, string[][]>(playing.map((p) => [p, []]));
  for (let run = 0; run < runs; run++) {
    // Each run starts at another player.
    const order = playing.map((_, i) => playing[(i + run) % playing.length]);
    for (const player of order) {
      const lines = await play[player](swf, kind);
      if (!lines.includes(DONE)) {
        throw new Error(`${player} did not finish ${bench}:\n${lines.join("\n")}`);
      }

      traced.set(player, checked(lines));
      output.get(player)?.push(lines);
      session.players[player].version =
        lines.find((l) => l.startsWith(VERSION))?.slice(VERSION.length) ?? "";
      const renderer = lines.find((l) => l.startsWith(RENDERER))?.slice(RENDERER.length);
      if (renderer) {
        session.players[player].renderer = renderer;
      }

      const sections = times.get(player) as Map<string, number[]>;
      for (const [section, value] of timed(lines)) {
        sections.set(section, [...(sections.get(section) ?? []), value]);
      }
    }
  }

  // Flash is the reference, the newest there is; what another traces otherwise is shown, and timed all the same.
  const referenceName =
    (["flash32", "adl", "flash11"] as const).find((p) => traced.has(p)) ?? playing[0];
  const reference = traced.get(referenceName) as string[];
  const differs: Partial<Record<PlayerName, string[]>> = {};
  for (const [player, lines] of traced) {
    const wrong = lines.filter((l, i) => l !== reference[i]);
    if (wrong.length || lines.length !== reference.length) {
      differs[player] = wrong;
      console.log(`${bench}: ${player} traces otherwise than ${referenceName}:`);
      for (const line of wrong.slice(0, 10)) {
        console.log(`  ${line}`);
      }
    }
  }

  // Each section's median in each player, and the others' against swf2es. A
  // drawing's sections are fps, frame times and memory, which a player may
  // not report: every player's, in the order first seen.
  const others = playing.includes("swf2es") ? playing.filter((p) => p !== "swf2es") : [];
  const sections = [...new Set(playing.flatMap((p) => [...(times.get(p)?.keys() ?? [])]))];
  const width = Math.max(...sections.map((s) => s.length)) + 2;
  const row = (name: string, measured: Map<PlayerName, number>) => {
    const mine = measured.get("swf2es") as number;
    const cells = playing.map((p) => String(measured.get(p)).padStart(10));
    const ratios = others.map((p) =>
      `${((measured.get(p) as number) / mine).toFixed(2)}×`.padStart(16),
    );
    console.log(`${name.padEnd(width)}${cells.join("")}${ratios.join("")}`);
  };
  const unit = kind === "drawing" ? "fps; frame times in ms; memory in MB" : "ms";
  console.log(`\n${bench}, median of ${runs} runs, ${unit}`);
  console.log(
    `${"".padEnd(width)}${playing.map((p) => p.padStart(10)).join("")}${others
      .map((p) => `${p}/swf2es`.padStart(16))
      .join("")}`,
  );
  const totals = new Map<PlayerName, number>(playing.map((p) => [p, 0]));
  for (const section of sections) {
    const medians = new Map(
      playing.map((p) => [p, median(times.get(p)?.get(section) ?? [Number.NaN])] as const),
    );
    for (const [p, value] of medians) {
      totals.set(p, (totals.get(p) as number) + value);
    }

    row(section, medians);
  }

  // A drawing's measures do not add up; what it shows is what drew them.
  if (kind === "script") {
    row("total", totals);
  } else {
    for (const p of playing) {
      console.log(`${p}: ${session.players[p].renderer ?? "the CPU"}`);
    }
  }

  // Written after each benchmark, so that one that fails later loses none before it.
  session.benchmarks[bench] = {
    times: Object.fromEntries([...times].map(([p, s]) => [p, Object.fromEntries(s)])),
    output: Object.fromEntries(output),
    reference: referenceName,
    differs,
  };
  if (values.json) {
    writeFileSync(resolve(values.json), `${JSON.stringify(session, null, 2)}\n`);
  }
}

if (values.json) {
  console.log(`\n${resolve(values.json)}`);
}
