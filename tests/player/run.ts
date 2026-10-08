// Plays the cases in cases.ts in the player, in headless Chrome, and checks
// their frames against Flash's in references/. Where a frame differs, its
// image, Flash's and their difference go to out/<case>/.
//
// A case marked `table`, or every case with --table-ab, is played again
// without the transform table (render/table.ts), and must draw the same
// pixels; a marked one, played with the table drawing even its shortest
// runs, must have the table draw some of it. An unmarked one keeps the
// table's threshold of 16 draws a run, so with --table-ab most of its runs
// are Pixi's pipe on both sides: the marked cases are the real guard.
//
//   node tests/player/run.ts [--table-ab] [case...]   check
//   node tests/player/run.ts --update [case...]       draw the references again in Flash
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cases, type PlayerCase } from "./cases.ts";
import { runPlayer } from "./chrome.ts";
import { compareImages, decodePng, differenceImage, encodePng } from "./image.ts";
import { libraryAbcs } from "./libraries.ts";
import { compiler, compileScripts } from "./scripts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const update = args.includes("--update");
const tableAb = args.includes("--table-ab");
const names = args.filter((a) => a !== "--update" && a !== "--table-ab");
const chosen = cases.filter((c) => !names.length || names.includes(c.name));
const reference = (name: string, frame: number) => `${here}references/${name}/frame-${frame}.png`;
const traceReference = (name: string) => `${here}references/${name}/trace.txt`;

// The scripted cases' ABCs, compiled in the oracle's container, and each case's SWF;
// the libraries the page serves them with, fetched if missing.
const scripts = compileScripts([...new Set(chosen.flatMap((c) => (c.script ? [c.script] : [])))]);
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
const traced = (c: PlayerCase) => Boolean(c.script || c.build);
const jobs = chosen.map((c) => ({ ...c, swf: swfOf(c), tableMinRun: c.table ? 1 : undefined }));

if (update) {
  // The oracle needs adl, which only this mode does.
  const { runFlash } = await import("../../oracle/flash.ts");
  const results = await runFlash(
    jobs.map((job, i) => {
      const flash = chosen[i].flash;
      return {
        ...job,
        swf:
          typeof flash === "function"
            ? flash(scripts.get(chosen[i].script ?? "") as Uint8Array)
            : (flash ?? job.swf),
      };
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
  const again = chosen.flatMap((c, i) => (c.table || tableAb ? [i] : []));
  const results = await runPlayer([...jobs, ...again.map((i) => ({ ...jobs[i], table: false }))]);
  const without = new Map(again.map((i, k) => [i, results[chosen.length + k]]));
  let failed = 0;
  for (const [i, c] of chosen.entries()) {
    const r = results[i];
    const problems: string[] = [];
    if (r.error) {
      problems.push(r.error);
    }

    rmSync(`${here}out/${c.name}`, { recursive: true, force: true });
    if (traced(c)) {
      const expected = readFileSync(traceReference(c.name), "utf8").replace(/\n$/, "").split("\n");
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

    if (c.table && r.tableDraws === 0) {
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
      console.log(`FAIL ${c.name}\n  ${problems.join("\n  ")}`);
    }
  }

  console.log(`${chosen.length - failed} of ${chosen.length} cases as Flash drew them`);
  if (failed) {
    process.exitCode = 1;
  }
}
