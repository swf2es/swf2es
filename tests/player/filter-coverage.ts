// Thin repeated geometry under wide blurs, glows and shadows, drawn into a
// multisampled target finer than the stage, as a page at a device pixel
// ratio of 2 or 3 draws it: once blurred, the stripes, hatching and
// checkerboard must come out as bright as a plain fill of their coverage,
// however their filter layer is drawn (render/filters.ts). A layer drawn
// coarser than the target, with fewer samples to a device pixel, made
// half-pixel stripes as opaque as a fill. And a shadow of no passes that
// hides its object draws the object's antialiased edges as they are.
//
// So at high quality a layer goes coarser only for thick content
// (render/detail.ts): thin geometry is drawn as the target draws, and thick
// shapes take the coarse layer, drawing near what best quality's exact layer
// draws. Medium and low take it for any content; a zero-pass shadow never.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

/** How far a thick shape's coarse layer may draw from its exact one, at most and on average. */
const THICK_MAX = 6;
const THICK_MEAN = 1.5;

interface Result {
  case: string;
  thin: number;
  plain: number;
}

interface Layer {
  case: string;
  resolution: number | string;
  antialias: string;
  target: number;
  /** For thick content, whether medium quality drew it coarse, as high then must. */
  medium?: boolean;
}

interface Delta {
  case: string;
  max: number;
  mean: number;
  coarse: number | string;
}

const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<{ results: Result[]; layers: Layer[]; deltas: Delta[] }>(`(async () => {
    const { autoDetectRenderer, Container, Graphics, RenderTexture } = await import("pixi.js");
    const { FilterChain, displayFilters } = await import("/player/render/filters.js");
    const { measureFilterArea } = await import("/player/render/blend.js");
    const { addParts } = await import("/player/render/detail.js");
    const { filterDefaults } = await import("/player/display/filters.js");
    const { MOVE, LINE } = await import("/player/display/shapes.js");
    const rect = (x, y, w, h) => [x, y, x + w, y, x + w, y + h, x, y + h];
    const disc = (cx, cy, r, n = 64) => {
      const points = [];
      for (let i = 0; i < n; i++) {
        points.push(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n));
      }

      return points;
    };
    const turned = (cx, cy, w, h, angle) => {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      return [-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2].map((v, i, a) =>
        i % 2 === 0 ? cx + v * c - a[i + 1] * s : cy + a[i - 1] * s + v * c);
    };
    // Each pattern as polygons, and the share of its area it covers.
    const stripes = [];
    for (let x = 20; x < 140; x++) stripes.push(rect(x + 0.1, 0, 0.5, 120));
    const hatching = [];
    for (let x = 0; x < 160; x += 1.3) hatching.push([x, 0, x + 0.4, 0, x + 20.4, 120, x + 20, 120]);
    const checker = [];
    for (let y = 0; y < 120; y += 0.5) for (let x = 20; x < 140; x += 0.5) if ((x + y) * 2 % 2 === 0) checker.push(rect(x, y, 0.5, 0.5));
    const patterns = { stripes: [stripes, 0.5], hatching: [hatching, 0.4 / 1.3], checker: [checker, 0.5] };
    // Thick content: solid shapes far wider than a texel, at fractional places.
    const thick = {
      disc: [disc(80.3, 60.2, 30.3)],
      bars: [rect(20.3, 30.6, 40.4, 60.3), rect(90.7, 20.1, 35.5, 22.2), rect(95.2, 70.4, 30.1, 30.9)],
      figure: [disc(80.1, 35.4, 16.2), turned(80.4, 75.3, 30.3, 44.1, 0.3), turned(55.6, 70.2, 12.2, 36.3, -0.6), turned(105.3, 72.4, 12.4, 36.1, 0.7)],
    };
    const toPath = (points) => {
      const path = [MOVE, points[0], points[1]];
      for (let i = 2; i < points.length; i += 2) path.push(LINE, points[i], points[i + 1]);
      path.push(LINE, points[0], points[1]);
      return path;
    };
    const partsOf = (polygons, least) => {
      const out = [];
      addParts(out, [{ fills: [{ fill: { type: "solid", color: 0xffffff }, contours: polygons.map(toPath), winding: "evenOdd" }], strokes: [] }], [1, 0, 0, 1], least);
      return out;
    };
    const filters = {
      "blur 64": { ...filterDefaults("blur"), blurX: 64, blurY: 64, quality: 1 },
      "blur 20 q2": { ...filterDefaults("blur"), blurX: 20, blurY: 20, quality: 2 },
      "glow 64": { ...filterDefaults("glow"), blurX: 64, blurY: 64, quality: 1, strength: 1, color: 0xffffff },
      "hiding shadow 40": { ...filterDefaults("dropShadow"), blurX: 40, blurY: 40, quality: 2, distance: 0, hideObject: true, color: 0xffffff },
    };
    const thickFilters = {
      "blur 32": { ...filterDefaults("blur"), blurX: 32, blurY: 32, quality: 1 },
      "blur 12 q3": { ...filterDefaults("blur"), blurX: 12, blurY: 12, quality: 3 },
      "glow 24": { ...filterDefaults("glow"), blurX: 24, blurY: 24, quality: 1, strength: 1, color: 0xff8000 },
      "glow 16 q2 strength 2": { ...filterDefaults("glow"), blurX: 16, blurY: 16, quality: 2, strength: 2, color: 0x00ffff },
      "shadow 10": { ...filterDefaults("dropShadow"), blurX: 10, blurY: 10, quality: 1, distance: 4, color: 0x000000, alpha: 1 },
      "hiding shadow 20": { ...filterDefaults("dropShadow"), blurX: 20, blurY: 20, quality: 2, distance: 0, hideObject: true, color: 0xffffff },
    };
    const results = [];
    const layers = [];
    const deltas = [];
    // The object drawn under the filter at the stage's quality, its parts told by \`parts\` (null: none).
    const draw = (renderer, target, filter, polygons, fill, quality = "HIGH", parts = null) => {
      const root = new Container();
      const object = new Container();
      root.addChild(object);
      const art = new Graphics();
      for (const points of polygons) art.poly(points);
      art.fill({ color: 0xffffff, alpha: fill });
      object.addChild(art);
      const chain = filter ? new FilterChain(displayFilters([filter]), object, true, 1, 1) : null;
      if (chain) {
        chain.quality = quality;
        chain.detail = parts && (() => parts);
      }

      object.filters = chain ? [chain] : [];
      renderer.render({ container: root, target, clear: true });
      const layer = chain ? { resolution: chain.resolution, antialias: chain.antialias } : null;
      const { pixels, width } = renderer.extract.pixels({ target });
      chain?.destroy();
      root.destroy({ children: true });
      const at = (x, y) => pixels[(y * width + x) * 4 + 3];
      return { at, pixels, layer };
    };
    for (const resolution of [1, 2, 2.79, 3]) {
      for (const samples of [4, 8]) {
        const renderer = await autoDetectRenderer({ width: 160, height: 120, resolution, preference: "webgl",
          antialias: false, backgroundAlpha: 0, useBackBuffer: true });
        renderer.renderTarget.adaptor.msaaSamples = samples;
        renderer.renderTarget.adaptor.backBufferSamples = samples;
        renderer.filter.filterAreaHook = measureFilterArea;
        const target = RenderTexture.create({ width: 160, height: 120, resolution, antialias: true });
        const mid = (x) => Math.round(x * resolution);
        const least = 1 / resolution;
        const name = resolution + "x " + samples + " samples, ";
        for (const [pn, [polygons, coverage]] of Object.entries(patterns)) {
          const parts = partsOf(polygons, least);
          for (const [fn, filter] of Object.entries(filters)) {
            // A glow keeps its object, sharp: it is read where it glows alone, left of the object.
            const glow = filter.kind === "glow";
            if (glow && pn === "hatching") {
              continue;
            }

            const [x, y] = glow ? [6, 60] : [80, 60];
            // At high, told what the pattern is: its thin parts keep the target's layer.
            const thin = draw(renderer, target, filter, polygons, 1, "HIGH", parts);
            const plain = draw(renderer, target, filter, [pn === "hatching" ? rect(0, 0, 160, 120) : rect(20, 0, 120, 120)], coverage);
            results.push({ case: name + pn + ", " + fn, thin: thin.at(mid(x), mid(y)), plain: plain.at(mid(x), mid(y)) });
            layers.push({ case: name + pn + ", " + fn + ", high", ...thin.layer, target: resolution });
            if (fn === "blur 20 q2") {
              for (const quality of ["MEDIUM", "LOW"]) {
                const coarse = draw(renderer, target, filter, polygons, 1, quality, parts);
                layers.push({ case: name + pn + ", " + fn + ", " + quality.toLowerCase(), ...coarse.layer, target: resolution });
              }
            }
          }
        }

        // Thick shapes at high go coarse, near what best's exact layer draws.
        for (const [sn, polygons] of Object.entries(thick)) {
          const parts = partsOf(polygons, least);
          for (const [fn, filter] of Object.entries(thickFilters)) {
            const high = draw(renderer, target, filter, polygons, 1, "HIGH", parts);
            const best = draw(renderer, target, filter, polygons, 1, "BEST", parts);
            const medium = draw(renderer, target, filter, polygons, 1, "MEDIUM", parts).layer.resolution;
            let max = 0;
            let sum = 0;
            for (let i = 0; i < high.pixels.length; i++) {
              const d = Math.abs(high.pixels[i] - best.pixels[i]);
              max = Math.max(max, d);
              sum += d;
            }

            deltas.push({ case: name + sn + ", " + fn, max, mean: sum / high.pixels.length, coarse: high.layer.resolution });
            layers.push({ case: name + sn + ", " + fn + ", high (thick)", ...high.layer, target: resolution,
              medium: typeof medium === "number" && medium < resolution });
          }
        }

        // A shadow of no passes hiding its object: the object's alpha, edges antialiased, at any quality.
        const round = [disc(80, 60, 30.3)];
        const roundParts = partsOf(round, least);
        const shadow = { ...filterDefaults("dropShadow"), blurX: 64, blurY: 64, quality: 0, distance: 0, hideObject: true, color: 0xffffff };
        const bare = draw(renderer, target, null, round, 1);
        for (const quality of ["HIGH", "MEDIUM", "LOW"]) {
          const shadowed = draw(renderer, target, shadow, round, 1, quality, roundParts);
          let worst = 0;
          for (let y = 0; y < Math.round(120 * resolution); y++) {
            for (let x = 0; x < Math.round(160 * resolution); x++) {
              worst = Math.max(worst, Math.abs(shadowed.at(x, y) - bare.at(x, y)));
            }
          }

          results.push({ case: name + "zero-pass shadow's edge, " + quality.toLowerCase(), thin: worst, plain: 0 });
          layers.push({ case: name + "zero-pass shadow, " + quality.toLowerCase(), ...shadowed.layer, target: resolution });
        }

        target.destroy(true);
        renderer.destroy();
      }
    }

    return { results, layers, deltas };
  })()`),
);
if (exception) {
  throw new Error(exception);
}

const { results, layers, deltas } = value as {
  results: Result[];
  layers: Layer[];
  deltas: Delta[];
};
const bad: string[] = [];
for (const r of results) {
  // Two levels for the passes' truncation and the samples' own placing.
  if (Math.abs(r.thin - r.plain) > 4) {
    bad.push(`${r.case}: ${r.thin}, as a fill ${r.plain}`);
  }
}

assert.deepEqual(bad, [], "thin geometry blurred as bright as its coverage");

// Which layer each took: at one texel a stage pixel always the target's.
const wrong: string[] = [];
for (const l of layers) {
  const coarse = typeof l.resolution === "number" && l.resolution < l.target;
  const sampled = l.antialias === "inherit";
  const fine = l.target === 1;
  let want: boolean;
  if (l.case.includes("zero-pass")) {
    want = !coarse && sampled;
  } else if (l.case.endsWith("high (thick)")) {
    want = fine ? !coarse && sampled : coarse === l.medium;
  } else if (l.case.endsWith(", high")) {
    want = !coarse && sampled;
  } else {
    want = fine ? !coarse && sampled : coarse;
  }

  if (!want) {
    wrong.push(`${l.case}: resolution ${l.resolution}, antialias ${l.antialias}`);
  }
}

assert.deepEqual(wrong, [], "thick content goes coarse at high, thin content does not");

const off: string[] = [];
let worst = 0;
let mean = 0;
for (const d of deltas) {
  worst = Math.max(worst, d.max);
  mean = Math.max(mean, d.mean);
  if (process.env.SWF2ES_COVERAGE_LOG) {
    console.log(`${d.case}: layer ${d.coarse}, max ${d.max}, mean ${d.mean.toFixed(3)}`);
  }

  // A coarse layer's blur is near the exact one's, a few levels at its steepest.
  if (d.max > THICK_MAX || d.mean > THICK_MEAN) {
    off.push(`${d.case}: max ${d.max}, mean ${d.mean.toFixed(3)}`);
  }
}

assert.deepEqual(off, [], "thick content drawn coarse near its exact layer");
console.log(
  `filter-coverage: ${results.length + layers.length + deltas.length} cases ok; thick content coarse vs exact: max ${worst}, mean ${mean.toFixed(3)} at most`,
);
