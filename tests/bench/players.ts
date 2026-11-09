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
// drawing (drawing/Drawing.as): scenes of vectors, bitmaps, filters, text,
// redrawn graphics and a Pixel Bender fill at three loads each, and
// stage3d, Stage3D's alone, on a page that turns it on for it alone, played at 60 frames a second
// on the GPU, swf2es in its browser build's element as a page has it; each
// level's fps and frame times, by getTimer, and memory: what System says,
// and in Chrome its JS heap and its ArrayBuffers apart (wasm's memory is
// there; the GPU's and other processes' nowhere), not to be set against
// Flash's figures. adl, not Flash Player, does not draw them. And startup
// (startup-hello, startup-as3pb): the time from making the player to a
// SWF's first line, cold and warm, and the bytes of the player's files a
// page fetched for it, raw, gzipped and in brotli. And cpu (cpu/Cpu.as):
// the CPU time the player's processes take to keep a still stage and a
// light animation going, a core's whole being 100%, read from /proc (Linux).
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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpus, release, totalmem, type } from "node:os";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { runFlash } from "../../oracle/flash.ts";
import { container, runOracle } from "../../oracle/oracle.ts";
import { translate } from "../../packages/context3d/dist/index.js";
import { readSwf, tags } from "../../packages/format/dist/index.js";
import { PbjAssembler } from "../pbj-assembler.ts";
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
var playersMarks:Array = [];

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

// A line the runner acts on as it comes, which a projector sends at once.
function playersMark(line:String):void {
  playersReport(line);
  if (Capabilities.playerType != "StandAlone") {
    return;
  }

  var request:URLRequest = new URLRequest("mark");
  request.method = URLRequestMethod.POST;
  request.data = line;
  var loader:URLLoader = new URLLoader();
  loader.addEventListener(IOErrorEvent.IO_ERROR, function(event:Event):void {});
  playersMarks.push(loader);
  loader.load(request);
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
   * on the GPU, which adl, not Flash Player, is left out of; or startup, a
   * SWF that reports at once, timed from the player's making to its report;
   * or cpu (cpu/Cpu.as), played as drawing is, the CPU time of the
   * player's processes between its marks.
   */
  kind: "script" | "drawing" | "startup" | "cpu";
  /** Whether its page turns Stage3D on for it. */
  stage3D?: boolean;
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
          ascArgs: ["-AS3", "-optimize", "-inline", "-strict", ...as3pbInputs()],
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
 * Drawing.as playing `scenes`, each at three loads: a line a level,
 * "frames: vectors-500 fps 59.9 p50 17 ...", and in a browser
 * "memory: vectors-500 heap 1234 buffers 5678" after it (heapAfter).
 * Stage3D plays in a SWF of its own, on a page that turns it on for it
 * alone: swf2es composites its stage otherwise where a page has Stage3D.
 */
const drawing = (name: string, scenes: string[], stage3D = false): Bench => ({
  kind: "drawing",
  stage3D,
  swf() {
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
    const [vertex, fragment] = stage3DProgram();
    const source = readFileSync(`${here}drawing/Drawing.as`, "utf8")
      .replace("PLAYERS_KERNEL", hex(plasma()))
      .replace("PLAYERS_VERTEX", hex(vertex))
      .replace("PLAYERS_FRAGMENT", hex(fragment))
      .replace("PLAYERS_ONLY", scenes.join(","));
    const abc = compileScripts([{ name, source: `${source}\n${REPORT}` }], out).get(
      name,
    ) as Uint8Array;
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
});

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

/**
 * How long a player takes to start a SWF and how much it downloads: a SWF
 * that reports as its script runs, its own or after as3pb's classes.
 * In a browser, the time is from the page's making the player, its code
 * fetched too, to the line: cold in a new profile, then warm, a second
 * player in the same page. In a projector, from its request for the SWF to
 * the report, without Wine's start: a launch is always cold. Lines
 * "startup: cold 812" and "startup: warm 95", and in a browser
 * "startup: bytes 4096000", what the page fetched of the player's files.
 */
function startup(name: string, entry: string, ascArgs: () => string[] = () => []): Bench {
  return {
    kind: "startup",
    swf() {
      mkdirSync(`${out}/sources`, { recursive: true });
      const source = `${out}/sources/${name}.as`;
      writeFileSync(
        source,
        `${MAIN}${REPORT}\n${entry}\nplayersReport("started");\nplayersFinish();\n`,
      );
      const [result] = runOracle([{ source, name, ascArgs: ascArgs() }], out, {
        imports: ["builtin", "playerglobal"],
        run: false,
      });
      if (!result.compiled) {
        throw new Error(`${name} did not compile:\n${result.compileLog}`);
      }

      return benchSwf(new Uint8Array(readFileSync(`${out}/${name}.abc`)), "script");
    },
    sections(lines) {
      const found: (readonly [string, number])[] = [];
      for (const l of lines) {
        const m = /^startup: (cold|warm|bytes) (\d+)/.exec(l);
        if (m?.[1] === "bytes") {
          found.push(["kb", Math.round(Number(m[2]) / 1024)]);
          const packed = / gzip (\d+) brotli (\d+)$/.exec(l);
          if (packed) {
            found.push(["gzip-kb", Math.round(Number(packed[1]) / 1024)]);
            found.push(["brotli-kb", Math.round(Number(packed[2]) / 1024)]);
          }
        } else if (m) {
          found.push([`${m[1]}-ms`, Number(m[2])]);
        }
      }

      return found;
    },
  };
}

/** as3pb's sources as -in files, for its SWF and its startup's. */
function as3pbInputs(): string[] {
  const dir = `${root}tests/programs/as3pb/`;
  return (
    readFileSync(`${dir}runtime/test/bench/shell-sources.txt`, "utf8")
      .split("\n")
      // Not avmshell's stand-ins for playerglobal's classes.
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("runtime/test/shell/"))
      .flatMap((s) => ["-in", relative(root, `${dir}${s}`)])
  );
}

/** Drawing's shader: a plasma, the sine of x and the cosine of y, scaled and moved by `time`. */
function plasma(): Uint8Array {
  return new PbjAssembler()
    .version(1)
    .name("Plasma")
    .param("in", "float2", "f0.rg", "_OutCoord")
    .param("out", "float4", "f1.rgba", "dst")
    .param("in", "float", "f2.r", "time")
    .ld("f3.r", 0.031)
    .op("mov", "f4.rg", "f0.rg")
    .op("mul", "f4.rg", "f3.rr")
    .op("add", "f4.rg", "f2.rr")
    .op("sin", "f5.r", "f4.r")
    .op("cos", "f5.g", "f4.g")
    .op("mov", "f5.b", "f5.r")
    .op("mul", "f5.b", "f5.g")
    .ld("f6.r", 0.5)
    .op("mul", "f5.rgb", "f6.rrr")
    .op("add", "f5.rgb", "f6.rrr")
    .op("mov", "f1.rgb", "f5.rgb")
    .ld("f1.a", 1)
    .bytes();
}

/**
 * The CPU a player takes to keep a still stage and a light animation going
 * (cpu/Cpu.as): "cpu: still percent 12.5", a core's whole being 100, from
 * every process the runner started between the scene's marks (cpuMark).
 */
const cpu: Bench = {
  kind: "cpu",
  swf() {
    const source = readFileSync(`${here}cpu/Cpu.as`, "utf8");
    const abc = compileScripts([{ name: "PlayersCpu", source: `${source}\n${REPORT}` }], out).get(
      "PlayersCpu",
    ) as Uint8Array;
    return benchSwf(abc, "drawing");
  },
  sections: (lines) =>
    lines.flatMap((l) => {
      const m = /^cpu: (\S+) percent ([\d.]+)$/.exec(l);
      return m ? [[`${m[1]} cpu-%`, Number(m[2])] as const] : [];
    }),
};

/** The clock ticks a second /proc counts CPU time in. */
const CLOCK_TICKS =
  process.platform === "linux"
    ? Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }))
    : 100;

/**
 * The CPU time, in clock ticks, of every process this one started and
 * theirs: Chrome's, or the projector's under Wine. Null but on Linux.
 */
function descendantTicks(): number | null {
  if (process.platform !== "linux") {
    return null;
  }

  const parents = new Map<number, number>();
  const ticks = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }

    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // After the name, which may hold spaces: state, ppid, ..., utime and stime, the 14th and 15th.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(name), Number(fields[1]));
      ticks.set(Number(name), Number(fields[11]) + Number(fields[12]));
    } catch {
      // Gone since the directory was read.
    }
  }

  let sum = 0;
  for (const [pid, t] of ticks) {
    let parent = parents.get(pid);
    while (parent && parent !== process.pid) {
      parent = parents.get(parent);
    }

    if (parent === process.pid) {
      sum += t;
    }
  }

  return sum;
}

const cpuBegun = new Map<string, readonly [number, number]>();

/** At a "cpu: begin" mark, the time and CPU time; at its "cpu: end", the line of the share between them. */
function cpuMark(line: string): string | null {
  const m = /^cpu: (begin|end) (\S+)$/.exec(line);
  const ticks = m ? descendantTicks() : null;
  if (!m || ticks === null) {
    return null;
  }

  if (m[1] === "begin") {
    cpuBegun.set(m[2], [ticks, performance.now()]);
    return null;
  }

  const begun = cpuBegun.get(m[2]);
  if (!begun) {
    return null;
  }

  const seconds = (performance.now() - begun[1]) / 1000;
  const share = ((ticks - begun[0]) / CLOCK_TICKS / seconds) * 100;
  return `cpu: ${m[2]} percent ${Math.round(share * 10) / 10}`;
}

/**
 * Drawing's stage3d program, in AGAL 1: each vertex moved by the draw's
 * constant, `add vt0, va0, vc0; mov op, vt0; mov v0, va1`, and its colour
 * passed on, `mov oc, v0`. The player's own translator reads both first,
 * so that a slip here fails the build, not a player.
 */
function stage3DProgram(): [Uint8Array, Uint8Array] {
  // A token: opcode, destination, then two sources of two words each, as AGAL lays them out.
  const program = (fragment: boolean, tokens: number[][]) => {
    const bytes = new Uint8Array(7 + tokens.length * 24);
    const view = new DataView(bytes.buffer);
    bytes[0] = 0xa0;
    view.setUint32(1, 1, true);
    bytes[5] = 0xa1;
    bytes[6] = fragment ? 1 : 0;
    for (const [i, token] of tokens.entries()) {
      for (const [k, word] of token.entries()) {
        view.setUint32(7 + i * 24 + k * 4, word, true);
      }
    }

    return bytes;
  };
  // Register types: 0 attribute, 1 constant, 2 temporary, 3 output, 4 varying; 0xe4 is xyzw.
  const vertex = program(false, [
    [0x01, 0x020f0000, 0xe4000000, 0, 0xe4000000, 1],
    [0x00, 0x030f0000, 0xe4000000, 2, 0, 0],
    [0x00, 0x040f0000, 0xe4000001, 0, 0, 0],
  ]);
  const fragment = program(true, [[0x00, 0x030f0000, 0xe4000000, 4, 0, 0]]);
  translate(vertex, "vertex");
  translate(fragment, "fragment");
  return [vertex, fragment];
}

const BENCHES: Record<string, Bench> = {
  enumeration: script("enumeration/Enumeration.as"),
  dictionary: script("dictionary/DictionaryAccess.as"),
  vector: script("vector/VectorAccess.as"),
  as3pb,
  lz4,
  drawing: drawing("PlayersDrawing", ["vectors", "bitmaps", "filters", "text", "redraw", "shader"]),
  stage3d: drawing("PlayersStage3D", ["stage3d"], true),
  cpu,
  "startup-hello": startup("PlayersStartupHello", ""),
  // as3pb's classes, a message made: its library loaded and its first methods compiled.
  "startup-as3pb": startup(
    "PlayersStartupAs3pb",
    "import bench.BenchMessage;\nnew BenchMessage();",
    () => ["-AS3", "-optimize", "-inline", "-strict", ...as3pbInputs()],
  ),
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

async function playSwf2es(swf: Uint8Array, { kind, stage3D = false }: Bench): Promise<string[]> {
  if (kind === "drawing" || kind === "cpu") {
    return playSwf2esLive(swf, stage3D);
  }

  if (kind === "startup") {
    return playStartup("swf2es", swf);
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
      const share = cpuMark(line);
      if (share) {
        lines.push(share);
      }

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

/**
 * What a page does to start the SWF in a player, and to wait for its
 * "started": in swf2es the browser build's element, whose traces reach
 * console.log; in Ruffle its player, by its trace observer. Each resolves
 * with the time "started" came.
 */
const STARTERS = {
  swf2es: `async (heard) => {
    const log = console.log;
    console.log = (...args) => {
      log.apply(console, args);
      heard(args.map(String).join(" "));
    };
    if (!customElements.get("swf2es-player")) {
      await import("/swf2es/swf2es.js");
    }

    const player = document.createElement("swf2es-player");
    player.setAttribute("src", "/bench/bench.swf");
    player.setAttribute("width", "100");
    player.setAttribute("height", "50");
    document.body.append(player);
    return () => {
      console.log = log;
      player.remove();
    };
  }`,
  ruffle: `async (heard) => {
    if (!window.RufflePlayer?.newest) {
      await new Promise((loaded, failed) => {
        const script = document.createElement("script");
        script.src = "/ruffle/ruffle.js";
        script.onload = loaded;
        script.onerror = failed;
        document.head.append(script);
      });
    }

    const player = window.RufflePlayer.newest().createPlayer();
    player.style.cssText = "width: 100px; height: 50px";
    document.body.append(player);
    // Set before the load too: the script runs as the first frame does.
    player.ruffle().traceObserver = heard;
    await player.ruffle().load({
      url: "/bench/bench.swf",
      autoplay: "on",
      unmuteOverlay: "hidden",
      splashScreen: false,
      logLevel: "error",
    });
    player.ruffle().traceObserver = heard;
    return () => player.remove();
  }`,
};

/**
 * A startup in a browser player, cold in a new profile and then warm in the
 * same page, and the player's files the page fetched: their bytes as they
 * are, and gzipped and in brotli as a server would send them.
 */
async function playStartup(player: "swf2es" | "ruffle", swf: Uint8Array): Promise<string[]> {
  const code =
    player === "swf2es"
      ? { at: "/swf2es/", dir: `${root}packages/swf2es/dist/` }
      : { at: "/ruffle/", dir: `${ruffle}/` };
  const dir = `${out}/live/`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}bench.swf`, swf);
  return withPage(
    "runSwf",
    async (evaluate, send, _fresh, listen) => {
      const fetched = new Set<string>();
      listen("Network.responseReceived", (params) => {
        const { pathname } = new URL((params.response as { url: string }).url);
        if (pathname.startsWith(code.at)) {
          fetched.add(pathname.slice(code.at.length));
        }
      });
      await send("Network.enable");
      const answer = await evaluate<{ cold: number; warm: number; lines: string[] }>(`(async () => {
        const start = ${STARTERS[player]};
        const lines = [];
        const once = async () => {
          const begun = performance.now();
          let started;
          const heard = new Promise((r) => (started = r));
          const stop = await start((line) => {
            lines.push(line);
            if (line === "started") {
              started(performance.now());
            }
          });
          const at = await heard;
          // The line after, which the report sends last.
          await new Promise((r) => setTimeout(r, 100));
          stop();
          return Math.round(at - begun);
        };
        const cold = await once();
        const warm = await once();
        return { cold, warm, lines };
      })()`);
      if (answer.exception || !answer.value) {
        throw new Error(`${player}: ${answer.exception}`);
      }

      const { cold, warm, lines } = answer.value;
      const files = [...fetched].map((f) => readFileSync(`${code.dir}${f}`));
      const sum = (sizes: number[]) => sizes.reduce((n, m) => n + m, 0);
      const raw = sum(files.map((f) => f.length));
      const gzip = sum(files.map((f) => gzipSync(f, { level: 9 }).length));
      const brotli = sum(
        files.map(
          (f) => brotliCompressSync(f, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
        ),
      );
      return [
        ...lines,
        `startup: cold ${cold}`,
        `startup: warm ${warm}`,
        `startup: bytes ${raw} gzip ${gzip} brotli ${brotli}`,
        `players: files ${[...fetched].sort().join(" ")}`,
      ];
    },
    true,
    {
      timeout: SCRIPT_SECONDS * 1000,
      mounts: [
        [code.at, code.dir],
        ["/bench/", dir],
      ],
    },
  );
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
 * Stage3D turned on in a page as the site turns it on
 * (apps/site/src/stage3d.ts): the browser build has no surface of its own.
 * This context3d is not the build's copy, so an error it threw would not be
 * the build's Context3DError and would reach the SWF unmapped; the
 * benchmark's scene makes none.
 */
const STAGE3D_SURFACE = `
  const { WebGLContext3D } = await import("/context3d/webgl/index.js");
  configure({
    stage3D: () => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
      });
      return {
        canvas,
        context: new WebGLContext3D(gl),
        destroy: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
      };
    },
  });
`;

/**
 * Drawing in swf2es as a page has it: the browser build's <swf2es-player>,
 * playing as the display's frames come, on the GPU. The SWF's traces reach
 * the console.
 */
async function playSwf2esLive(swf: Uint8Array, stage3D: boolean): Promise<string[]> {
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
        const { configure } = await import("/swf2es/swf2es.js");
        ${stage3D ? STAGE3D_SURFACE : ""}
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
        ["/context3d/", `${root}packages/context3d/dist/`],
        ["/bench/", dir],
      ],
    },
  );
}

async function playRuffle(swf: Uint8Array, { kind }: Bench): Promise<string[]> {
  if (kind === "startup") {
    return playStartup("ruffle", swf);
  }

  const drawn = kind === "drawing" || kind === "cpu";
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
async function playProjector(
  player: PlayerName,
  swf: Uint8Array,
  kind: Bench["kind"],
): Promise<string[]> {
  let reported!: (body: string) => void;
  const report = new Promise<string>((r) => (reported = r));
  // A startup's time: from the projector's request for the SWF to its report's.
  let requested = 0;
  let reporting = 0;
  // What its marks gave: the CPU between them.
  const marked: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/bench.swf") {
      requested = performance.now();
      response.writeHead(200, { "content-type": "application/x-shockwave-flash" });
      response.end(swf);
      return;
    }

    if (request.method === "POST" && request.url === "/mark") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.end("ok");
        const share = cpuMark(Buffer.concat(chunks).toString("utf8"));
        if (share) {
          marked.push(share);
        }
      });
      return;
    }

    if (request.method === "POST" && request.url === "/report") {
      reporting = performance.now();
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
    const lines = [...body.split("\n"), ...marked];
    return kind === "startup"
      ? [...lines, `startup: cold ${Math.round(reporting - requested)}`]
      : lines;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }

    server.close();
  }
}

const play: Record<PlayerName, (swf: Uint8Array, bench: Bench) => Promise<string[]>> = {
  swf2es: playSwf2es,
  ruffle: playRuffle,
  adl: (swf) => playAdl(swf),
  flash32: (swf, { kind }) => playProjector("flash32", swf, kind),
  flash11: (swf, { kind }) => playProjector("flash11", swf, kind),
};

// The lines every player must trace alike: not times, a drawing's measures, or the harness's own.
const checked = (lines: string[]) =>
  lines.filter((l) => l && !/^(time|frames|memory|cpu|startup|players): /.test(l));
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
  // adl is AIR: a script runs in it as in Flash Player, but it neither draws nor starts as one.
  const playing = kind === "script" ? players : players.filter((p) => p !== "adl");
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
      const lines = await play[player](swf, BENCHES[bench]);
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
  const unit = {
    script: "ms",
    drawing: "fps; frame times in ms; memory in MB",
    startup: "ms and KB",
    cpu: "% of a core",
  }[kind];
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

  // Only times add up; a drawing shows what drew it.
  if (kind === "script") {
    row("total", totals);
  } else if (kind === "drawing") {
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
