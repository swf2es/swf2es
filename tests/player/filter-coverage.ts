// Thin repeated geometry under wide blurs, glows and shadows, drawn into a
// multisampled target finer than the stage, as a page at a device pixel
// ratio of 2 or 3 draws it: once blurred, the stripes, hatching and
// checkerboard must come out as bright as a plain fill of their coverage,
// however their filter layer is drawn (render/filters.ts). A layer drawn
// coarser than the target, with fewer samples to a device pixel, made
// half-pixel stripes as opaque as a fill. And a shadow of no passes that
// hides its object draws the object's antialiased edges as they are.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

interface Result {
  case: string;
  thin: number;
  plain: number;
}

const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<Result[]>(`(async () => {
    const { autoDetectRenderer, Container, Graphics, RenderTexture } = await import("pixi.js");
    const { FilterChain, displayFilters } = await import("/player/render/filters.js");
    const { measureFilterArea } = await import("/player/render/blend.js");
    const { filterDefaults } = await import("/player/display/filters.js");
    // Each pattern, and the share of its area it covers.
    const patterns = {
      stripes: [(g) => { for (let x = 20; x < 140; x++) g.rect(x + 0.1, 0, 0.5, 120); }, 0.5],
      hatching: [(g) => { for (let x = 0; x < 160; x += 1.3) g.poly([x, 0, x + 0.4, 0, x + 20.4, 120, x + 20, 120]); }, 0.4 / 1.3],
      checker: [(g) => { for (let y = 0; y < 120; y += 0.5) for (let x = 20; x < 140; x += 0.5) if ((x + y) * 2 % 2 === 0) g.rect(x, y, 0.5, 0.5); }, 0.5],
    };
    const filters = {
      "blur 64": { ...filterDefaults("blur"), blurX: 64, blurY: 64, quality: 1 },
      "blur 20 q2": { ...filterDefaults("blur"), blurX: 20, blurY: 20, quality: 2 },
      "glow 64": { ...filterDefaults("glow"), blurX: 64, blurY: 64, quality: 1, strength: 1, color: 0xffffff },
      "hiding shadow 40": { ...filterDefaults("dropShadow"), blurX: 40, blurY: 40, quality: 2, distance: 0, hideObject: true, color: 0xffffff },
    };
    const results = [];
    const draw = (renderer, target, filter, paint, fill) => {
      const root = new Container();
      const object = new Container();
      root.addChild(object);
      const art = new Graphics();
      paint(art);
      art.fill({ color: 0xffffff, alpha: fill });
      object.addChild(art);
      const chain = filter ? new FilterChain(displayFilters([filter]), object, true, 1, 1) : null;
      object.filters = chain ? [chain] : [];
      renderer.render({ container: root, target, clear: true });
      const { pixels, width } = renderer.extract.pixels({ target });
      chain?.destroy();
      root.destroy({ children: true });
      return (x, y) => pixels[(y * width + x) * 4 + 3];
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
        for (const [pn, [paint, coverage]] of Object.entries(patterns)) {
          for (const [fn, filter] of Object.entries(filters)) {
            // A glow keeps its object, sharp: it is read where it glows alone, left of the object.
            const glow = filter.kind === "glow";
            if (glow && pn === "hatching") {
              continue;
            }

            const [x, y] = glow ? [6, 60] : [80, 60];
            const thin = draw(renderer, target, filter, paint, 1);
            const plain = draw(renderer, target, filter, (g) => g.rect(pn === "hatching" ? 0 : 20, 0, pn === "hatching" ? 160 : 120, 120), coverage);
            results.push({ case: resolution + "x " + samples + " samples, " + pn + ", " + fn,
              thin: thin(mid(x), mid(y)), plain: plain(mid(x), mid(y)) });
          }
        }

        // A shadow of no passes hiding its object: the object's alpha, edges antialiased.
        const disc = (g) => g.circle(80, 60, 30.3);
        const shadow = { ...filterDefaults("dropShadow"), blurX: 64, blurY: 64, quality: 0, distance: 0, hideObject: true, color: 0xffffff };
        const shadowed = draw(renderer, target, shadow, disc, 1);
        const bare = draw(renderer, target, null, disc, 1);
        let worst = 0;
        for (let y = 0; y < Math.round(120 * resolution); y++) {
          for (let x = 0; x < Math.round(160 * resolution); x++) {
            worst = Math.max(worst, Math.abs(shadowed(x, y) - bare(x, y)));
          }
        }

        results.push({ case: resolution + "x " + samples + " samples, zero-pass shadow's edge", thin: worst, plain: 0 });
        target.destroy(true);
        renderer.destroy();
      }
    }

    return results;
  })()`),
);
if (exception) {
  throw new Error(exception);
}

const bad: string[] = [];
for (const r of value as Result[]) {
  // Two levels for the passes' truncation and the samples' own placing.
  if (Math.abs(r.thin - r.plain) > 4) {
    bad.push(`${r.case}: ${r.thin}, as a fill ${r.plain}`);
  }
}

assert.deepEqual(bad, [], "thin geometry blurred as bright as its coverage");
console.log(`filter-coverage: ${(value as Result[]).length} cases ok`);
