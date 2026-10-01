// Checks Ruffle's expected outputs against the Flash oracle: whether Flash,
// as AIR's adl runs it, traces what output.txt holds and draws what the
// expected PNGs hold, within the tests' tolerances. Where they differ, the
// oracle is Flash and the corpus is not.
//
//   node tests/player/corpus/check-references.ts [path prefix...]
import { readFileSync } from "node:fs";
import { runFlash } from "../../../oracle/flash.ts";
import { compareImages, compareImagesNear, decodePng } from "../image.ts";
import { collectRuffle } from "./ruffle.ts";

const prefixes = process.argv.slice(2);
const tests = collectRuffle(prefixes).filter((t) => !t.ignore);
const results = await runFlash(
  tests.map((t) => ({
    swf: new Uint8Array(readFileSync(t.swf)),
    frames: t.frames,
    quality: t.quality,
    capture: [...new Set(t.images.map((i) => i.frame))],
  })),
);

let traced = 0;
let tracedSame = 0;
let drawn = 0;
let drawnSame = 0;
let drawnNear = 0;
let incomplete = 0;
for (const [i, t] of tests.entries()) {
  const r = results[i];
  if (r.incomplete) {
    incomplete++;
    console.log(`INCOMPLETE ${t.path}`);
    continue;
  }

  if (t.output !== null) {
    traced++;
    const expected = t.output.replace(/\r/g, "").replace(/\n$/, "");
    const actual = r.output.join("\n").replace(/\n$/, "");
    if (expected === actual) {
      tracedSame++;
    } else {
      const e = expected.split("\n");
      const a = actual.split("\n");
      const line = e.findIndex((l, k) => l !== a[k]);
      const at = line < 0 ? e.length : line;
      console.log(
        `TRACE ${t.path} line ${at + 1}: ruffle ${JSON.stringify(e[at] ?? "<end>")} flash ${JSON.stringify(a[at] ?? "<end>")}`,
      );
    }
  }

  for (const check of t.images) {
    drawn++;
    const png = r.images.get(check.frame);
    if (!png) {
      console.log(`IMAGE ${t.path} ${check.name}: no frame ${check.frame}`);
      continue;
    }

    const c = compareImages(
      decodePng(png),
      decodePng(readFileSync(check.expected)),
      check.tolerance,
    );
    if (c.outliers <= check.maxOutliers) {
      drawnSame++;
    } else if (
      compareImagesNear(
        decodePng(png),
        decodePng(readFileSync(check.expected)),
        Math.max(check.tolerance, 8),
      ).outliers <= check.maxOutliers
    ) {
      drawnNear++;
    } else {
      console.log(
        `IMAGE ${t.path} ${check.name}: ${c.sizeDiffers ? "size differs" : `${c.outliers} outliers (allowed ${check.maxOutliers}), max difference ${c.maxDifference}`}`,
      );
    }
  }
}

console.log(
  `${tests.length} tests: traces ${tracedSame} of ${traced} as Ruffle's, images ${drawnSame} of ${drawn} (and ${drawnNear} with edges a pixel off), ${incomplete} incomplete`,
);
