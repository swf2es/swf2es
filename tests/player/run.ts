// Plays the cases in cases.ts in the player, in headless Chrome, and checks
// their frames against Flash's in references/. Where a frame differs, its
// image, Flash's and their difference go to out/<case>/.
//
// A case marked `table`, or every case with --table-ab, is played again
// without the transform table (render/table.ts), and must draw the same
// pixels; a marked one, played with the table drawing even its shortest
// runs as multi-draws, must have the table draw some of it. An unmarked
// one keeps the table's threshold of 16 draws a run, so with --table-ab
// most of its runs are drawn from the table's atlas a call a draw on one
// side and by Pixi's pipe on the other.
//
// A case marked `gap`, a known gap, is neither checked nor drawn unless
// named, though the default run still builds its SWF: named, it is checked
// and expected to fail, and one that passes is reported for its mark to
// come off.
//
// With SWF2ES_RENDERER=own the cases are drawn by the renderer of swf2es's
// own (docs/renderer.md), which grows beside Pixi: how many it draws as Flash
// does is how complete it is. own-renderer.json lists those it does, and one
// listed that fails again fails the run; one that passes and is not listed is
// added by --update-baseline, from a run of every case. Its failures are
// printed only for cases named.
//
//   node tests/player/run.ts [--table-ab] [case...]   check
//   node tests/player/run.ts --update [case...]       draw the references again in Flash
//   SWF2ES_RENDERER=own node tests/player/run.ts [--update-baseline] [case...]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAs3, readSwf } from "../../packages/format/dist/index.js";
import { cases, type PlayerCase } from "./cases.ts";
import { runPlayer } from "./chrome.ts";
import { compareImages, decodePng, differenceImage, encodePng } from "./image.ts";
import { libraryAbcs } from "./libraries.ts";
import { compiler, compileScripts } from "./scripts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const update = args.includes("--update");
const tableAb = args.includes("--table-ab");
const lazyCompilation = args.includes("--lazy");
const own = process.env.SWF2ES_RENDERER === "own";
const updateBaseline = args.includes("--update-baseline");
const names = args.filter((a) => !a.startsWith("--"));
const ownBaseline = `${here}own-renderer.json`;
// A case marked as a known gap runs only when named; left out, its SWF is
// still built, so that a gap case that no longer builds is noticed.
const chosen = cases.filter((c) => (names.length ? names.includes(c.name) : !c.gap));
const gaps = update || names.length ? [] : cases.filter((c) => c.gap);
const reference = (name: string, frame: number) => `${here}references/${name}/frame-${frame}.png`;
const traceReference = (name: string) => `${here}references/${name}/trace.txt`;

// The scripted cases' ABCs, compiled in the oracle's container, and each case's SWF;
// the libraries the page serves them with, fetched if missing.
const scripts = compileScripts([
  ...new Set([...chosen, ...gaps].flatMap((c) => (c.script ? [c.script] : []))),
]);
if (scripts.size || chosen.some((c) => c.build)) {
  libraryAbcs();
}
const compile = compiler();
const swfOf = (c: PlayerCase): Uint8Array => {
  if (c.build) {
    return c.build(compile);
  }

  return typeof c.swf === "function"
    ? c.swf(scripts.get(c.script ?? "") as Uint8Array)
    : (c.swf as Uint8Array);
};
/** Whether `swf` is an AVM1 SWF; one that does not read is not. */
const isAvm1 = (swf: Uint8Array): boolean => {
  try {
    return !isAs3(readSwf(swf));
  } catch {
    return false;
  }
};
const traced = (c: PlayerCase) => Boolean(c.script || c.build || c.traced);
const jobs = chosen.map((c) => ({
  ...c,
  swf: swfOf(c),
  tableMinRun: c.table ? 1 : undefined,
  lazyCompilation,
}));
for (const c of gaps) {
  swfOf(c);
}

if (update) {
  // The oracle needs adl, which only this mode does.
  const { runFlash } = await import("../../oracle/flash.ts");
  // The harness loads each SWF with a Loader, where an AVM1 SWF runs as an
  // AVM1Movie, whose first frame's traces adl prints only with its second:
  // it is given two frames at least.
  const results = await runFlash(
    jobs.map((job, i) => {
      const flash = chosen[i].flash;
      const swf =
        typeof flash === "function"
          ? flash(scripts.get(chosen[i].script ?? "") as Uint8Array)
          : (flash ?? job.swf);
      return { ...job, swf, frames: isAvm1(swf) ? Math.max(job.frames, 2) : job.frames };
    }),
  );
  for (const [i, c] of chosen.entries()) {
    const r = results[i];
    if (r.incomplete) {
      console.log(`${c.name}: Flash did not finish`);
      process.exitCode = 1;
      continue;
    }

    rmSync(`${here}references/${c.name}`, { recursive: true, force: true });
    mkdirSync(`${here}references/${c.name}`, { recursive: true });
    for (const [frame, png] of r.images) {
      writeFileSync(reference(c.name, frame), png);
    }

    if (traced(c)) {
      writeFileSync(traceReference(c.name), `${r.output.join("\n")}\n`);
    }

    console.log(
      `${c.name}: ${r.images.size} frames${traced(c) ? `, ${r.output.length} lines traced` : ""}`,
    );
  }
} else {
  // The cases to play again without the table, after the rest.
  const again = own ? [] : chosen.flatMap((c, i) => (c.table || tableAb ? [i] : []));
  const results = await runPlayer([...jobs, ...again.map((i) => ({ ...jobs[i], table: false }))]);
  const without = new Map(again.map((i, k) => [i, results[chosen.length + k]]));
  let failed = 0;
  const passing: string[] = [];
  for (const [i, c] of chosen.entries()) {
    const r = results[i];
    const problems: string[] = [];
    if (r.error) {
      problems.push(r.error);
    }

    rmSync(`${here}out/${c.name}`, { recursive: true, force: true });
    if (traced(c)) {
      const expected = readFileSync(traceReference(c.name), "utf8")
        .replace(/\n$/, "")
        .split(/\r|\n/);
      const got = r.trace;
      const at = got.findIndex((line, i) => line !== expected[i]);
      if (at >= 0 || got.length !== expected.length) {
        const i = at < 0 ? Math.min(got.length, expected.length) : at;
        problems.push(
          `trace line ${i + 1}: ${JSON.stringify(got[i] ?? "(end)")}, Flash ${JSON.stringify(expected[i] ?? "(end)")}`,
        );
      }
    }

    for (const frame of c.capture) {
      const actual = r.images.get(frame);
      if (!actual) {
        problems.push(`frame ${frame}: not drawn`);
        continue;
      }

      const expected = readFileSync(reference(c.name, frame));
      const a = decodePng(actual);
      const e = decodePng(expected);
      const d = compareImages(a, e, c.tolerance);
      if (d.outliers <= c.maxOutliers) {
        continue;
      }

      problems.push(
        d.sizeDiffers
          ? `frame ${frame}: ${a.width}×${a.height}, not ${e.width}×${e.height}`
          : `frame ${frame}: ${d.outliers} outliers (allowed ${c.maxOutliers}), max difference ${d.maxDifference}`,
      );
      const out = `${here}out/${c.name}`;
      mkdirSync(out, { recursive: true });
      writeFileSync(`${out}/frame-${frame}.png`, actual);
      writeFileSync(`${out}/frame-${frame}.flash.png`, expected);
      if (!d.sizeDiffers) {
        writeFileSync(`${out}/frame-${frame}.difference.png`, encodePng(differenceImage(a, e)));
      }
    }

    if (c.table && r.tableDraws === 0 && !own) {
      problems.push("the transform table drew none of it");
    }

    const plain = without.get(i);
    for (const frame of plain ? c.capture : []) {
      const a = r.images.get(frame);
      const b = plain?.images.get(frame);
      if (!a || !b) {
        problems.push(`frame ${frame}: not drawn ${a ? "without" : "with"} the table`);
        continue;
      }

      const d = compareImages(decodePng(a), decodePng(b), 0);
      if (d.outliers > 0) {
        problems.push(
          `frame ${frame}: ${d.outliers} pixels differ without the table, by up to ${d.maxDifference}`,
        );
        const out = `${here}out/${c.name}`;
        mkdirSync(out, { recursive: true });
        writeFileSync(`${out}/frame-${frame}.no-table.png`, b);
      }
    }

    if (problems.length) {
      failed++;
      if (!own || names.length) {
        console.log(`FAIL ${c.name}\n  ${problems.join("\n  ")}`);
      }
    } else if (own) {
      passing.push(c.name);
    } else if (c.gap) {
      console.log(`${c.name} draws as Flash does: its gap (${c.gap}) is closed, take the mark off`);
    }
  }

  console.log(`${chosen.length - failed} of ${chosen.length} cases as Flash drew them`);
  if (own) {
    // The own renderer is held to what it drew before, not to every case.
    const listed: string[] = JSON.parse(readFileSync(ownBaseline, "utf8"));
    const ran = new Set(chosen.map((c) => c.name));
    const now = new Set(passing);
    const lost = listed.filter((name) => ran.has(name) && !now.has(name));
    const gained = passing.filter((name) => !listed.includes(name));
    for (const name of lost) {
      console.log(`REGRESSED ${name}: the own renderer drew it as Flash did`);
    }

    if (gained.length) {
      console.log(`now drawn as Flash does: ${gained.join(", ")}`);
    }

    if (updateBaseline && !names.length) {
      writeFileSync(ownBaseline, `${JSON.stringify([...now].sort(), null, 2)}\n`);
      console.log(`own-renderer.json: ${now.size} cases`);
    } else {
      process.exitCode = lost.length ? 1 : 0;
    }
  } else if (failed) {
    process.exitCode = 1;
  }
}
