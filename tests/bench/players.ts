// Times a benchmark's sections in the players a SWF plays in: swf2es and
// Ruffle's web build, each in headless Chrome, and Flash, AIR's adl without
// the debugger. The benchmarks are those that time themselves for
// avmshell (enumeration/Enumeration.as, dictionary/DictionaryAccess.as),
// compiled against playerglobal into a SWF whose document class is empty:
// their script runs as it is loaded, its sections tracing their times
// ("time: dense1k-in 120") by the Date, which each player keeps the same
// way. Their other lines must be as Flash traces them.
//
//   node tests/bench/players.ts [--runs N] [--ruffle DIR] [--only swf2es,ruffle,flash] [bench...]
//
// DIR is Ruffle's self-hosted web build, unpacked (its ruffle.js inside),
// or RUFFLE names it; without one Ruffle is left out. Flash needs adl as
// oracle/flash.ts does. The players take turns, in an order that changes
// each run, so that none always runs after another; the table gives each
// section's median in each, and the others against swf2es.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runFlash } from "../../oracle/flash.ts";
import { tags } from "../../packages/format/dist/index.js";
import { runPlayer, withPage } from "../player/chrome.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const BENCHES: Record<string, string> = {
  enumeration: "enumeration/Enumeration.as",
  dictionary: "dictionary/DictionaryAccess.as",
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

const benches = positionals.length ? positionals : Object.keys(BENCHES);
for (const bench of benches) {
  if (!BENCHES[bench]) {
    console.log(`no benchmark ${bench}: ${Object.keys(BENCHES).join(", ")}`);
    process.exit(1);
  }
}

/** The benchmark as a SWF: its script, with an empty document class beside it, and room to run. */
function benchSwf(bench: string): Uint8Array {
  const source = readFileSync(`${here}${BENCHES[bench]}`, "utf8");
  const name = `Players${bench[0].toUpperCase()}${bench.slice(1)}`;
  const abc = compileScripts(
    [
      {
        name,
        source: `package {\nimport flash.display.Sprite;\npublic class Main extends Sprite {}\n}\n${source}\ntrace("${DONE}");\n`,
      },
    ],
    `${here}out/players`,
  ).get(name) as Uint8Array;
  const limits = new Uint8Array(4);
  new DataView(limits.buffer).setUint16(0, 1000, true);
  new DataView(limits.buffer).setUint16(2, SCRIPT_SECONDS, true);
  return w.swf({
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

async function playFlash(swf: Uint8Array): Promise<string[]> {
  const [result] = await runFlash([{ swf, frames: 2, capture: [], alone: true }], 60_000, {
    timed: true,
  });
  if (result.incomplete || result.errors.length) {
    throw new Error(`Flash: ${result.incomplete ? "incomplete" : result.errors.join("\n")}`);
  }

  return result.output;
}

const play: Record<PlayerName, (swf: Uint8Array) => Promise<string[]>> = {
  swf2es: playSwf2es,
  ruffle: playRuffle,
  flash: playFlash,
};

const timed = (lines: string[]) =>
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

  // Flash is the reference; what another traces otherwise is shown, and timed all the same.
  const referenceName = traced.has("flash") ? "flash" : players[0];
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
