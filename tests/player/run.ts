// Plays the cases in cases.ts in the player, in headless Chrome, and checks
// their frames against Flash's in references/. Where a frame differs, its
// image, Flash's and their difference go to out/<case>/.
//
//   node tests/player/run.ts [case...]            check
//   node tests/player/run.ts --update [case...]   draw the references again in Flash
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
const names = args.filter((a) => a !== "--update");
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
const jobs = chosen.map((c) => ({ ...c, swf: swfOf(c) }));

if (update) {
  // The oracle needs adl, which only this mode does.
  const { runFlash } = await import("../../oracle/flash.ts");
  const results = await runFlash(jobs);
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
  const results = await runPlayer(jobs);
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
