// Times a benchmark's sections in the players a SWF plays in: swf2es and
// Ruffle's web build, each in headless Chrome, and Flash, AIR's adl without
// the debugger. The AS3 benchmarks (the group `avm2`) are those that time
// themselves for avmshell (enumeration, dictionary, primitives, typed,
// untyped and native-collections under their names), random/Random.as,
// Math.random in loops, vector/VectorAccess.as,
// indexed access to Vectors and Arrays, and pixels/BitmapPixels.as, a
// bitmap's pixels set and read whole, each compiled against playerglobal
// into a SWF whose document class is empty: their script runs as it is
// loaded, its sections tracing their times ("time: dense1k-in 120") by the
// Date, which each player keeps the same way. Their other lines must be as
// Flash traces them. display/Display.as and display/EnterFrame.as are
// whole files whose document class runs them, beside a library clip "ball"
// linked to Ball; display-frames times ENTER_FRAME on many Sprites over
// frames. as3pb is tests/programs/as3pb's benchmark, protobuf through
// ByteArray and domain memory against AMF3 and JSON, and lz4 LZ4's C as
// Crossbridge's gcc builds it into a SWF, with lz4/Console.as its console.
//
// The AVM1 benchmarks (avm1-*, or the group `avm1`) are AS1 sources under
// avm1/, compiled by tests/avm1-script.ts as Flash's compiler writes them
// into a SWF 8 whose first frame runs avm1/Bench.as and then them, beside a
// library clip "ball" to attach. They report the same way; avm1-frames
// times onEnterFrame on many clips over frames rather than in one script.
//
//   node tests/bench/players.ts [--runs N] [--ruffle DIR] [--only swf2es,ruffle,flash]
//     [--write-swf OUT] [bench...]
//
// DIR is Ruffle's self-hosted web build, unpacked (its ruffle.js inside),
// or RUFFLE names it; without one Ruffle is left out. Flash needs adl as
// oracle/flash.ts does. The players take turns, in an order that changes
// each run, so that none always runs after another; the table gives each
// section's median in each, and the others against swf2es. --write-swf
// writes each benchmark's SWF into OUT, as <bench>.swf, and plays none.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runFlash } from "../../oracle/flash.ts";
import { buildCrossbridgeSwf, runOracle } from "../../oracle/oracle.ts";
import { readSwf, tags } from "../../packages/format/dist/index.js";
import { flashAssembler, script } from "../avm1-script.ts";
import { square } from "../player/cases/common.ts";
import { runPlayer, withPage } from "../player/chrome.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = `${here}out/players`;

interface Bench {
  source?: string;
  /** AS1 for AVM1, not AS3. */
  avm1?: boolean;
  /** Frames it runs for, its frame rate: one that times frames calls done() itself. */
  frames?: [number, number];
  /** A whole AS3 file, whose public Main is the document class and traces DONE itself. */
  main?: boolean;
  /** "ball" in the library, linked to the file's public Ball. */
  ball?: boolean;
  /** A SWF made otherwise than from a source here. */
  build?: () => Uint8Array;
  /** Frames to play a script for, if not its two. */
  played?: number;
  /** Its sections and their times from its lines, where they are not "time: name ms". */
  sections?: (lines: string[]) => (readonly [string, number])[];
  /** getTimer by the wall clock in swf2es, whose test page keeps it by the frames. */
  realTime?: boolean;
}

const BENCHES: Record<string, Bench> = {
  enumeration: { source: "enumeration/Enumeration.as" },
  dictionary: { source: "dictionary/DictionaryAccess.as" },
  vector: { source: "vector/VectorAccess.as" },
  pixels: { source: "pixels/BitmapPixels.as" },
  primitives: { source: "primitives/Primitives.as" },
  random: { source: "random/Random.as" },
  typed: { source: "typed/Typed.as" },
  untyped: { source: "untyped/Untyped.as" },
  "native-collections": { source: "native-collections/Collections.as" },
  display: { source: "display/Display.as", main: true, ball: true },
  // As avm1-frames: three phases of 30 frames and one more each, at SWF's most frames a second.
  "display-frames": { source: "display/EnterFrame.as", main: true, frames: [100, 255] },
  as3pb: { build: as3pbSwf, sections: as3pbSections },
  // Its program starts on the second frame, after Crossbridge's preloader.
  lz4: { build: lz4Swf, played: 4, sections: lz4Sections, realTime: true },
  "avm1-loop": { source: "avm1/Loop.as", avm1: true },
  "avm1-members": { source: "avm1/Members.as", avm1: true },
  "avm1-calls": { source: "avm1/Calls.as", avm1: true },
  "avm1-scope": { source: "avm1/Scope.as", avm1: true },
  "avm1-clips": { source: "avm1/Clips.as", avm1: true },
  // Three phases of 30 frames and one more each, after the first; 255 frames a second, SWF's most.
  "avm1-frames": { source: "avm1/EnterFrame.as", avm1: true, frames: [100, 255] },
};
const GROUPS: Record<string, string[]> = {
  avm1: Object.keys(BENCHES).filter((b) => BENCHES[b].avm1),
  avm2: Object.keys(BENCHES).filter((b) => !BENCHES[b].avm1),
};
const PLAYERS = ["swf2es", "ruffle", "flash"] as const;
type PlayerName = (typeof PLAYERS)[number];
const DONE = "players: done";
// A script may run for this long in any of them: the sections run in one
// frame, and the slowest player takes minutes over some benchmarks.
const SCRIPT_SECONDS = 1200;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: "string", default: "3" },
    ruffle: { type: "string", default: process.env.RUFFLE },
    only: { type: "string", default: PLAYERS.join(",") },
    "write-swf": { type: "string" },
  },
});
const runs = Number(values.runs);
const ruffle = values.ruffle ? resolve(values.ruffle) : undefined;
const players = values.only
  .split(",")
  .filter((p): p is PlayerName => (PLAYERS as readonly string[]).includes(p))
  .filter((p) => p !== "ruffle" || ruffle !== undefined);
if (values.only.includes("ruffle") && ruffle === undefined) {
  console.log("Ruffle left out: --ruffle or RUFFLE names its self-hosted web build");
}

const benches = (positionals.length ? positionals : Object.keys(BENCHES)).flatMap(
  (b) => GROUPS[b] ?? [b],
);
for (const bench of benches) {
  if (!BENCHES[bench]) {
    console.log(
      `no benchmark ${bench}: ${[...Object.keys(BENCHES), ...Object.keys(GROUPS)].join(", ")}`,
    );
    process.exit(1);
  }
}

/** A ScriptLimits tag's body: room to recurse, and SCRIPT_SECONDS to run. */
function limits(): Uint8Array {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint16(0, 1000, true);
  new DataView(body.buffer).setUint16(2, SCRIPT_SECONDS, true);
  return body;
}

// An empty document class, to put before a script that runs as it is loaded. Its base is
// named in full, as a script may have a class Sprite of its own (Untyped.as).
const MAIN =
  "package {\nimport flash.display.Sprite;\npublic class Main extends flash.display.Sprite {}\n}\n";

/** The benchmark as a SWF: its script, with an empty document class beside it, and room to run. */
function benchSwf(bench: string): Uint8Array {
  const { source, avm1, main, ball, frames, build } = BENCHES[bench];
  if (avm1) {
    return avm1Swf(bench);
  }

  if (build) {
    return build();
  }

  const text = readFileSync(`${here}${source}`, "utf8");
  const name = `Players${bench[0].toUpperCase()}${bench.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase())}`;
  const abc = compileScripts(
    [{ name, source: main ? text : `${MAIN}${text}\ntrace("${DONE}");\n` }],
    out,
  ).get(name) as Uint8Array;
  return as3Swf(abc, frames, ball);
}

/**
 * An ABC as a SWF of version 18, Flash Player 11.5's, for JSON (11's),
 * which Untyped.as and as3pb use: Flash shows a SWF only its version's API.
 * Its script runs in the first of two frames; or over `frames`, at their
 * rate, on a larger stage; with `ball`, "ball" is in the library, a clip of
 * one square, linked to the class Ball.
 */
function as3Swf(abc: Uint8Array, frames?: [number, number], ball = false): Uint8Array {
  const library = ball
    ? [
        square(1, 0x3366cc, 200),
        w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      ]
    : [];
  return w.swf({
    version: 18,
    width: frames ? 400 : 100,
    height: frames ? 300 : 50,
    frameRate: frames?.[1] ?? 24,
    frameCount: frames ? 1 : 2,
    tags: [
      w.fileAttributes(true),
      w.tag(tags.ScriptLimits, limits()),
      ...library,
      w.doAbc(abc, "Main"),
      w.symbolClass(
        ball
          ? [
              [0, "Main"],
              [2, "Ball"],
            ]
          : [[0, "Main"]],
      ),
      w.showFrame(),
      ...(frames ? [] : [w.showFrame()]),
      w.end(),
    ],
  });
}

/** as3pb's benchmark: its library and messages as -in files, in the order avmshell's build lists them. */
function as3pbSwf(): Uint8Array {
  const dir = `${root}tests/programs/as3pb/`;
  const inputs = readFileSync(`${dir}runtime/test/bench/shell-sources.txt`, "utf8")
    .split("\n")
    // Not avmshell's stand-ins for playerglobal's classes.
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("runtime/test/shell/"))
    .flatMap((s) => ["-in", relative(root, `${dir}${s}`)]);
  mkdirSync(`${out}/sources`, { recursive: true });
  const source = `${out}/sources/PlayersAs3pb.as`;
  writeFileSync(
    source,
    `${MAIN}import bench.Benchmark;

new Benchmark(function(message:String, measured:Boolean):void {
  trace(measured ? "time: " + message : message);
}).run();
trace("${DONE}");
`,
  );
  const [result] = runOracle(
    [
      {
        source,
        name: "PlayersAs3pb",
        ascArgs: ["-AS3", "-optimize", "-inline", "-strict", ...inputs],
      },
    ],
    out,
    { imports: ["builtin", "playerglobal"], run: false },
  );
  if (!result.compiled) {
    throw new Error(`as3pb did not compile:\n${result.compileLog}`);
  }

  return as3Swf(new Uint8Array(readFileSync(`${out}/PlayersAs3pb.abc`)));
}

// "time: AS3PB bytes: 128ms" under "--- Serialize ---" and "--- Deserialize ---"; the
// totals after them are their sums.
function as3pbSections(lines: string[]): (readonly [string, number])[] {
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
}

/**
 * LZ4 in C (tests/programs/lz4) as Crossbridge builds a SWF of it: gcc as
 * tests/programs/run.ts runs it for avmshell, but -emit-swf, with
 * lz4/Console.as as its console. Its whole run is in its second frame's
 * script, so it is given room as the others are.
 */
function lz4Swf(): Uint8Array {
  const [built] = runOracle(
    [
      {
        source: `${here}lz4/Console.as`,
        name: "lz4/Console",
        ascArgs: ["-md", "-AS3", "-strict", "-optimize"],
      },
    ],
    out,
    {
      imports: [
        "builtin",
        "playerglobal",
        "BinaryData",
        "ISpecialFile",
        "IBackingStore",
        "IVFS",
        "InMemoryBackingStore",
        "PlayerKernel",
        "CModule",
      ],
      run: false,
    },
  );
  if (!built.compiled) {
    throw new Error(`lz4's console did not compile:\n${built.compileLog}`);
  }

  const vendor = "tests/programs/com-lz4-as3/native/vendor";
  const { swf, log } = buildCrossbridgeSwf(
    {
      name: "lz4",
      gccArgs: [
        "-O4",
        "-DNDEBUG",
        "-flto-api=tests/programs/com-lz4-as3/native/exports.txt",
        "-fllvm-opt-opt=-strip",
        "-disable-telemetry",
        `-I${vendor}`,
        "tests/programs/lz4/main.c",
        ...["lz4", "lz4hc", "lz4frame", "xxhash"].map((f) => `${vendor}/${f}.c`),
        `-symbol-abc=${relative(root, `${out}/lz4/Console.abc`)}`,
        "-emit-swf",
        "-swf-version=18",
        "-swf-size=100x50",
      ],
    },
    `${out}/lz4`,
    { compiler: "gcc" },
  );
  if (!swf) {
    throw new Error(`lz4 did not build:\n${log}`);
  }

  return withLimits(swf);
}

// "time: prose compress: 12 ms".
function lz4Sections(lines: string[]): (readonly [string, number])[] {
  return lines.flatMap((l) => {
    const m = /^time: (.+): (\d+) ms$/.exec(l);
    return m ? [[m[1].replace(/ /g, "-"), Number(m[2])] as const] : [];
  });
}

/** A SWF another tool made, with the ScriptLimits benchSwf gives its own, after FileAttributes. */
function withLimits(file: Uint8Array): Uint8Array {
  const swf = readSwf(file);
  const first = swf.tags[0];
  if (first?.code !== tags.FileAttributes || swf.tags.some((t) => t.code === tags.ScriptLimits)) {
    throw new Error("a SWF that does not start with FileAttributes, or has ScriptLimits");
  }

  const at = first.offset + first.length;
  const tag = w.tag(tags.ScriptLimits, limits());
  const bytes = new Uint8Array(swf.bytes.length + tag.length);
  bytes.set(swf.bytes.subarray(0, at));
  bytes.set(tag, at);
  bytes.set(swf.bytes.subarray(at), at + tag.length);
  // Uncompressed, of its new length.
  bytes.set([0x46, 0x57, 0x53], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length, true);
  return bytes;
}

/** An AVM1 benchmark as a SWF 8: Bench.as and its source in the first frame, "ball" in the library. */
function avm1Swf(bench: string): Uint8Array {
  const { source, frames } = BENCHES[bench];
  const as1 = [
    readFileSync(`${here}avm1/Bench.as`, "utf8"),
    readFileSync(`${here}${source}`, "utf8"),
  ];
  if (!frames) {
    as1.push("done();\n");
  }

  const ball = w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]);
  return w.swf({
    version: 8,
    width: 400,
    height: 300,
    frameRate: frames?.[1] ?? 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      w.tag(tags.ScriptLimits, limits()),
      square(1, 0x3366cc, 200),
      ball,
      w.exportAssets([[2, "ball"]]),
      w.doAction([...script(as1.join("\n"), 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

const framesOf = (bench: string) => BENCHES[bench].frames?.[0] ?? BENCHES[bench].played ?? 2;

// A benchmark of frames has them drawn, multisampled, as a host draws them: Flash draws its too.
async function playSwf2es(swf: Uint8Array, bench: string): Promise<string[]> {
  const drawn = BENCHES[bench].frames !== undefined;
  const [result] = await runPlayer(
    [
      {
        swf,
        frames: framesOf(bench),
        capture: [],
        draw: drawn,
        antialias: drawn,
        realTime: BENCHES[bench].realTime,
      },
    ],
    { timeout: SCRIPT_SECONDS * 1000 },
  );
  if (result.error) {
    throw new Error(`swf2es: ${result.error}`);
  }

  return result.trace;
}

async function playRuffle(swf: Uint8Array): Promise<string[]> {
  return withPage(
    "runSwf",
    async (evaluate) => {
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
        player.style.cssText = "width: 100px; height: 50px";
        document.body.append(player);
        // Set before the load too: the script runs as the first frame does.
        const observe = (line) => {
          lines.push(line);
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

      return answer.value as string[];
    },
    false,
    { timeout: SCRIPT_SECONDS * 1000, mounts: [["/ruffle/", `${ruffle}/`]] },
  );
}

// A program's output may wait in its C library's buffer for the whole of its run.
async function playFlash(swf: Uint8Array, bench: string): Promise<string[]> {
  const [result] = await runFlash(
    [{ swf, frames: framesOf(bench), capture: [], alone: true }],
    SCRIPT_SECONDS * 1000,
    { timed: true },
  );
  if (result.incomplete || result.errors.length) {
    throw new Error(`Flash: ${result.incomplete ? "incomplete" : result.errors.join("\n")}`);
  }

  return result.output;
}

const play: Record<PlayerName, (swf: Uint8Array, bench: string) => Promise<string[]>> = {
  swf2es: playSwf2es,
  ruffle: playRuffle,
  flash: playFlash,
};

const timed = (bench: string, lines: string[]) =>
  BENCHES[bench].sections?.(lines) ??
  lines.flatMap((l) => {
    const m = /^time: ([\w-]+) (\d+)$/.exec(l);
    return m ? [[m[1], Number(m[2])] as const] : [];
  });
const checked = (lines: string[]) =>
  lines.filter((l) => l && !l.startsWith("time: ") && l !== DONE);
const median = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// --write-swf: each benchmark's SWF, to profile or open elsewhere, and none played.
const swfs = values["write-swf"];
if (swfs) {
  mkdirSync(swfs, { recursive: true });
  for (const bench of benches) {
    writeFileSync(`${swfs}/${bench}.swf`, benchSwf(bench));
  }

  process.exit(0);
}

// The player's libraries, which its page loads from tests/player/out.
libraryAbcs();

for (const bench of benches) {
  const swf = benchSwf(bench);
  const times = new Map<PlayerName, Map<string, number[]>>(players.map((p) => [p, new Map()]));
  const traced = new Map<PlayerName, string[]>();
  for (let run = 0; run < runs; run++) {
    // Each run starts at another player.
    const order = players.map((_, i) => players[(i + run) % players.length]);
    for (const player of order) {
      const lines = await play[player](swf, bench);
      if (!lines.includes(DONE)) {
        throw new Error(`${player} did not finish ${bench}:\n${lines.join("\n")}`);
      }

      traced.set(player, checked(lines));
      const sections = times.get(player) as Map<string, number[]>;
      for (const [section, ms] of timed(bench, lines)) {
        sections.set(section, [...(sections.get(section) ?? []), ms]);
      }
    }
  }

  // Flash is the reference; what another traces otherwise is shown, and timed all the same.
  const referenceName = traced.has("flash") ? "flash" : players[0];
  const reference = traced.get(referenceName) as string[];
  for (const [player, lines] of traced) {
    const wrong = lines.flatMap((l, i) => (l !== reference[i] ? [i] : []));
    if (wrong.length || lines.length !== reference.length) {
      console.log(`${bench}: ${player} traces otherwise than ${referenceName}:`);
      for (const i of wrong.slice(0, 10)) {
        console.log(`  ${lines[i]}\n    ${referenceName}: ${reference[i] ?? "(nothing)"}`);
      }
    }
  }

  // Each section's median in each player, and the others' against swf2es.
  const others = players.includes("swf2es") ? players.filter((p) => p !== "swf2es") : [];
  const sections = [...(times.get(players[0]) as Map<string, number[]>).keys()];
  const width = Math.max(...sections.map((s) => s.length)) + 2;
  const row = (name: string, ms: Map<PlayerName, number>) => {
    const mine = ms.get("swf2es") as number;
    const cells = players.map((p) => String(ms.get(p)).padStart(10));
    const ratios = others.map((p) => `${((ms.get(p) as number) / mine).toFixed(2)}×`.padStart(16));
    console.log(`${name.padEnd(width)}${cells.join("")}${ratios.join("")}`);
  };
  console.log(`\n${bench}, median of ${runs} runs, ms`);
  console.log(
    `${"".padEnd(width)}${players.map((p) => p.padStart(10)).join("")}${others
      .map((p) => `${p}/swf2es`.padStart(16))
      .join("")}`,
  );
  const totals = new Map<PlayerName, number>(players.map((p) => [p, 0]));
  for (const section of sections) {
    const medians = new Map(
      players.map((p) => [p, median(times.get(p)?.get(section) ?? [Number.NaN])] as const),
    );
    for (const [p, ms] of medians) {
      totals.set(p, (totals.get(p) as number) + ms);
    }

    row(section, medians);
  }

  row("total", totals);
}
