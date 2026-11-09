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
// the same way. Their other lines must be as Flash traces them.
//
//   node tests/bench/players.ts [--runs N] [--ruffle DIR] [--flash32 EXE] [--flash11 EXE]
//     [--wine COMMAND] [--only swf2es,ruffle,adl,flash32,flash11] [--write-swf DIR] [bench...]
//
// DIR is Ruffle's self-hosted web build, unpacked (its ruffle.js inside),
// or RUFFLE names it; without one Ruffle is left out. adl is found as
// oracle/flash.ts finds it. EXE is a projector (flashplayer_32_sa.exe; the
// release one, as the debugger slows it), or FLASH32 and FLASH11 name them;
// each is left out without one. COMMAND runs a Windows program, "wine" by
// default, or WINE names it ("flatpak run --filesystem=home
// org.winehq.Wine"). A release projector traces nowhere, so it opens the
// SWF from a server here, and the SWF, seeing it plays in a projector,
// sends what it traced back to it and quits. --write-swf writes the
// benchmarks' SWFs into DIR and plays none, to open them elsewhere; outside
// a projector they trace, and in one they quit.
//
// The players take turns, in an order that changes each run, so that none
// always runs after another; the table gives each section's median in
// each, and the others against swf2es.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runFlash } from "../../oracle/flash.ts";
import { runOracle } from "../../oracle/oracle.ts";
import { tags } from "../../packages/format/dist/index.js";
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
  /** The ABC: the benchmark with the document class, and the report before it. */
  abc(): Uint8Array;
  /** Each timed section's name and milliseconds, in the order traced. */
  sections(lines: string[]): (readonly [string, number])[];
}

/** One of the benchmarks here: a script that times its sections by the Date. */
function script(path: string): Bench {
  return {
    abc() {
      const source = readFileSync(`${here}${path}`, "utf8").replace(/\btrace\(/g, "playersReport(");
      const name = `Players${path.replace(/^.*\//, "").replace(/\.as$/, "")}`;
      return compileScripts(
        [{ name, source: `${MAIN}${REPORT}\n${source}\nplayersFinish();\n` }],
        out,
      ).get(name) as Uint8Array;
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
  abc() {
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

    return new Uint8Array(readFileSync(`${out}/PlayersAs3pb.abc`));
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

const BENCHES: Record<string, Bench> = {
  enumeration: script("enumeration/Enumeration.as"),
  dictionary: script("dictionary/DictionaryAccess.as"),
  vector: script("vector/VectorAccess.as"),
  as3pb,
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
function benchSwf(abc: Uint8Array): Uint8Array {
  const limits = new Uint8Array(4);
  new DataView(limits.buffer).setUint16(0, 1000, true);
  new DataView(limits.buffer).setUint16(2, SCRIPT_SECONDS, true);
  return w.swf({
    version: 18,
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.tag(tags.ScriptLimits, limits),
      w.doAbc(abc, "Main"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

async function playSwf2es(swf: Uint8Array): Promise<string[]> {
  const [result] = await runPlayer([{ swf, frames: 2, capture: [] }], {
    timeout: SCRIPT_SECONDS * 1000,
  });
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

async function playAdl(swf: Uint8Array): Promise<string[]> {
  const [result] = await runFlash([{ swf, frames: 2, capture: [], alone: true }], 60_000, {
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

const play: Record<PlayerName, (swf: Uint8Array) => Promise<string[]>> = {
  swf2es: playSwf2es,
  ruffle: playRuffle,
  adl: playAdl,
  flash32: (swf) => playProjector("flash32", swf),
  flash11: (swf) => playProjector("flash11", swf),
};

const checked = (lines: string[]) =>
  lines.filter((l) => l && !l.startsWith("time: ") && l !== DONE);
const median = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Only the SWFs, to play elsewhere: DIR/<bench>.swf.
if (values["write-swf"]) {
  const dir = resolve(values["write-swf"]);
  mkdirSync(dir, { recursive: true });
  for (const bench of benches) {
    writeFileSync(`${dir}/${bench}.swf`, benchSwf(BENCHES[bench].abc()));
    console.log(`${dir}/${bench}.swf`);
  }

  process.exit(0);
}

// The player's libraries, which its page loads from tests/player/out.
libraryAbcs();

for (const bench of benches) {
  const { abc, sections: timed } = BENCHES[bench];
  const swf = benchSwf(abc());
  const times = new Map<PlayerName, Map<string, number[]>>(players.map((p) => [p, new Map()]));
  const traced = new Map<PlayerName, string[]>();
  for (let run = 0; run < runs; run++) {
    // Each run starts at another player.
    const order = players.map((_, i) => players[(i + run) % players.length]);
    for (const player of order) {
      const lines = await play[player](swf);
      if (!lines.includes(DONE)) {
        throw new Error(`${player} did not finish ${bench}:\n${lines.join("\n")}`);
      }

      traced.set(player, checked(lines));
      const sections = times.get(player) as Map<string, number[]>;
      for (const [section, ms] of timed(lines)) {
        sections.set(section, [...(sections.get(section) ?? []), ms]);
      }
    }
  }

  // Flash is the reference, the newest there is; what another traces otherwise is shown, and timed all the same.
  const referenceName =
    (["flash32", "adl", "flash11"] as const).find((p) => traced.has(p)) ?? players[0];
  const reference = traced.get(referenceName) as string[];
  for (const [player, lines] of traced) {
    const wrong = lines.filter((l, i) => l !== reference[i]);
    if (wrong.length || lines.length !== reference.length) {
      console.log(`${bench}: ${player} traces otherwise than ${referenceName}:`);
      for (const line of wrong.slice(0, 10)) {
        console.log(`  ${line}`);
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
