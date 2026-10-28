// Thin repeated geometry under wide blurs, glows and shadows, drawn into a
// multisampled target finer than the stage, as a page at a device pixel
// ratio of 2 or 3 draws it: once blurred, the stripes, hatching and
// checkerboard must come out as bright as a plain fill of their coverage
// (render/filters.ts). A layer drawn coarser than the target, with fewer
// samples to a device pixel, made half-pixel stripes as opaque as a fill.
// And a shadow of no passes that hides its object draws the object's
// antialiased edges as they are.
//
// So a layer is drawn coarser, or without samples, only at medium and low
// quality: at high, best and any other value the stage holds, it is the
// target's, which this asserts as well as the coverage. Thin parts sharing
// a fill with a thick one, or one contour of thin teeth, are drawn exact as
// any other.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

interface Result {
  case: string;
  thin: number;
  plain: number;
}

interface Layer {
  case: string;
  quality: string;
  resolution: number | string;
  antialias: string;
  target: number;
}

const COARSE = ["MEDIUM", "LOW"];
const EXACT = ["HIGH", "BEST", "8X8", "16X16", "16X16LINEAR", "high-ish"];

const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<{ results: Result[]; layers: Layer[] }>(`(async () => {
    const { autoDetectRenderer, Container, Graphics, RenderTexture } = await import("pixi.js");
    const { FilterChain, displayFilters } = await import("/player/render/filters.js");
    const { measureFilterArea } = await import("/player/render/blend.js");
    const { filterDefaults } = await import("/player/display/filters.js");
    const rect = (x, y, w, h) => [x, y, x + w, y, x + w, y + h, x, y + h];
    // Each pattern as polygons, its plain fill's rectangle, and the share of that it covers.
    const stripes = [];
    for (let x = 20; x < 140; x++) stripes.push(rect(x + 0.1, 0, 0.5, 120));
    const hatching = [];
    for (let x = 0; x < 160; x += 1.3) hatching.push([x, 0, x + 0.4, 0, x + 20.4, 120, x + 20, 120]);
    const checker = [];
    for (let y = 0; y < 120; y += 0.5) for (let x = 20; x < 140; x += 0.5) if ((x + y) * 2 % 2 === 0) checker.push(rect(x, y, 0.5, 0.5));
    // One contour: a wide block far off to the left, its teeth half a pixel wide across the middle.
    const comb = [-900, -400, -300, -400, -300, 0];
    for (let x = 140; x >= 20; x--) comb.push(x + 0.6, 0, x + 0.6, 120, x + 0.1, 120, x + 0.1, 0);
    comb.push(-300, 0, -300, 200, -900, 200);
    const middle = rect(20, 0, 120, 120);
    const patterns = {
      stripes: [stripes, middle, 0.5],
      hatching: [hatching, rect(0, 0, 160, 120), 0.4 / 1.3],
      checker: [checker, middle, 0.5],
      // Thin stripes in one fill with a thick block, out of the blurs' reach.
      "stripes and block": [[rect(-900, 0, 600, 600), ...stripes], middle, 0.5],
      comb: [[comb], middle, 0.5],
    };
    const filters = {
      "blur 64": { ...filterDefaults("blur"), blurX: 64, blurY: 64, quality: 1 },
      "blur 20 q2": { ...filterDefaults("blur"), blurX: 20, blurY: 20, quality: 2 },
      "glow 64": { ...filterDefaults("glow"), blurX: 64, blurY: 64, quality: 1, strength: 1, color: 0xffffff },
      "hiding shadow 40": { ...filterDefaults("dropShadow"), blurX: 40, blurY: 40, quality: 2, distance: 0, hideObject: true, color: 0xffffff },
    };
    const exact = ${JSON.stringify(EXACT)};
    const qualities = [...exact, ...${JSON.stringify(COARSE)}];
    const results = [];
    const layers = [];
    // The object drawn under the filter at the stage's quality, and the layer its chain took.
    const draw = (renderer, target, filter, polygons, fill, quality = "HIGH") => {
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
      }

      object.filters = chain ? [chain] : [];
      renderer.render({ container: root, target, clear: true });
      const layer = chain ? { resolution: chain.resolution, antialias: chain.antialias } : null;
      const { pixels, width } = renderer.extract.pixels({ target });
      chain?.destroy();
      root.destroy({ children: true });
      return { at: (x, y) => pixels[(y * width + x) * 4 + 3], layer };
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
        const name = resolution + "x " + samples + " samples, ";
        for (const [pn, [polygons, plainRect, coverage]] of Object.entries(patterns)) {
          for (const [fn, filter] of Object.entries(filters)) {
            // A glow keeps its object, sharp: it is read where it glows alone, left of the object.
            const glow = filter.kind === "glow";
            if (glow && pn === "hatching") {
              continue;
            }

            const [x, y] = glow ? [6, 60] : [80, 60];
            const plain = draw(renderer, target, filter, [plainRect], coverage);
            for (const quality of qualities) {
              const thin = draw(renderer, target, filter, polygons, 1, quality);
              layers.push({ case: name + pn + ", " + fn, quality, ...thin.layer, target: resolution });
              if (exact.includes(quality)) {
                results.push({ case: name + pn + ", " + fn + ", " + quality, thin: thin.at(mid(x), mid(y)), plain: plain.at(mid(x), mid(y)) });
              }
            }
          }
        }

        // A shadow of no passes hiding its object: the object's alpha, edges antialiased, at any quality.
        const disc = [];
        for (let i = 0; i < 64; i++) disc.push(80 + 30.3 * Math.cos((2 * Math.PI * i) / 64), 60 + 30.3 * Math.sin((2 * Math.PI * i) / 64));
        const shadow = { ...filterDefaults("dropShadow"), blurX: 64, blurY: 64, quality: 0, distance: 0, hideObject: true, color: 0xffffff };
        const bare = draw(renderer, target, null, [disc], 1);
        for (const quality of ["HIGH", "MEDIUM", "LOW"]) {
          const shadowed = draw(renderer, target, shadow, [disc], 1, quality);
          let worst = 0;
          for (let y = 0; y < Math.round(120 * resolution); y++) {
            for (let x = 0; x < Math.round(160 * resolution); x++) {
              worst = Math.max(worst, Math.abs(shadowed.at(x, y) - bare.at(x, y)));
            }
          }

          results.push({ case: name + "zero-pass shadow's edge, " + quality, thin: worst, plain: 0 });
          layers.push({ case: name + "zero-pass shadow", quality: "zero-pass " + quality, ...shadowed.layer, target: resolution });
        }

        target.destroy(true);
        renderer.destroy();
      }
    }

    return { results, layers };
  })()`),
);
if (exception) {
  throw new Error(exception);
}

const { results, layers } = value as { results: Result[]; layers: Layer[] };
const bad: string[] = [];
for (const r of results) {
  // Two levels for the passes' truncation and the samples' own placing.
  if (Math.abs(r.thin - r.plain) > 4) {
    bad.push(`${r.case}: ${r.thin}, as a fill ${r.plain}`);
  }
}

assert.deepEqual(bad, [], "thin geometry blurred as bright as its coverage");

// The layer each took: coarser or unsampled only at medium and low, where the target has texels
// to spare; the target's, multisampled, at every other quality and for a blur of no passes.
const wrong: string[] = [];
let fast = 0;
for (const l of layers) {
  const exact = l.resolution === "inherit" && l.antialias === "inherit";
  const want = COARSE.includes(l.quality) && l.target > 1 ? !exact : exact;
  fast += exact ? 0 : 1;
  if (!want) {
    wrong.push(`${l.case} at ${l.quality}: resolution ${l.resolution}, antialias ${l.antialias}`);
  }
}

assert.deepEqual(wrong, [], "coarse layers at medium and low alone");
console.log(
  `filter-coverage: ${results.length} coverage and ${layers.length} layer cases ok, ${fast} coarse`,
);
