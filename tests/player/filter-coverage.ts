// Thin repeated geometry under wide blurs, glows and shadows, drawn into a
// multisampled canvas finer than the stage, as a page at a device pixel
// ratio of 2 or 3 draws it: once blurred, the stripes, hatching and
// checkerboard must come out as bright as a plain fill of their coverage,
// however their filter layer is drawn (@swf2es/render's filters). A layer
// drawn coarser than the target, with fewer samples to a device pixel, made
// half-pixel stripes as opaque as a fill. And a shadow of no passes that
// hides its object draws the object's edges antialiased: a layer's samples
// may lie elsewhere in a pixel than the canvas's (its rows run down), so an
// edge pixel may come out a quarter of its coverage apart, but no more, as
// an aliased edge would.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

interface Result {
  case: string;
  thin: number;
  plain: number;
  /** How far apart the two may be, in levels; 4 where not given. */
  most?: number;
}

const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<Result[]>(`(async () => {
    const { RenderView } = await import("@swf2es/player/scene");
    const { Container, TRANSFORM } = await import("/player/display/display.js");
    const { Drawing } = await import("/player/display/drawing.js");
    const { filterDefaults } = await import("/player/display/filters.js");
    const { Tessellator } = await import("@swf2es/native/render");
    const tessellator = new Tessellator();
    // Each pattern, and the share of its area it covers.
    const rect = (d, x, y, w, h) => d.drawRect(x, y, w, h);
    const poly = (d, points) => {
      d.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) d.lineTo(points[i], points[i + 1]);
      d.lineTo(points[0], points[1]);
    };
    const patterns = {
      stripes: [(d) => { for (let x = 20; x < 140; x++) rect(d, x + 0.1, 0, 0.5, 120); }, 0.5],
      hatching: [(d) => { for (let x = 0; x < 160; x += 1.3) poly(d, [x, 0, x + 0.4, 0, x + 20.4, 120, x + 20, 120]); }, 0.4 / 1.3],
      checker: [(d) => { for (let y = 0; y < 120; y += 0.5) for (let x = 20; x < 140; x += 0.5) if ((x + y) * 2 % 2 === 0) rect(d, x, y, 0.5, 0.5); }, 0.5],
    };
    const filters = {
      "blur 64": { ...filterDefaults("blur"), blurX: 64, blurY: 64, quality: 1 },
      "blur 20 q2": { ...filterDefaults("blur"), blurX: 20, blurY: 20, quality: 2 },
      "glow 64": { ...filterDefaults("glow"), blurX: 64, blurY: 64, quality: 1, strength: 1, color: 0xffffff },
      "hiding shadow 40": { ...filterDefaults("dropShadow"), blurX: 40, blurY: 40, quality: 2, distance: 0, hideObject: true, color: 0xffffff },
    };
    const results = [];
    // The alpha of each pixel of \`paint\` filled white at \`fill\`, under \`filter\`, rows from
    // the top.
    const draw = (view, filter, paint, fill) => {
      const root = new Container();
      const object = new Container();
      const drawing = new Drawing();
      drawing.beginFill({ type: "solid", color: ((Math.round(fill * 255) << 24) | 0xffffff) >>> 0 });
      paint(drawing);
      drawing.endFill();
      object.drawing = drawing;
      if (filter) {
        object.filters = [filter];
        object.invalidate(TRANSFORM);
      }
      root.addChildAt(object, 0);
      view.render(root);
      const gl = view.gl;
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return (x, y) => pixels[((height - 1 - y) * width + x) * 4 + 3];
    };
    try {
      for (const resolution of [1, 2, 2.79, 3]) {
        for (const samples of [4, 8]) {
          const view = new RenderView({ width: 160, height: 120, resolution, transparent: true,
            preserveDrawingBuffer: true, samples, fillTessellator: tessellator.tessellate });
          const mid = (x) => Math.round(x * resolution);
          try {
            for (const [pn, [paint, coverage]] of Object.entries(patterns)) {
              for (const [fn, filter] of Object.entries(filters)) {
                // A glow keeps its object, sharp: it is read where it glows alone, left of the
                // object.
                const glow = filter.kind === "glow";
                if (glow && pn === "hatching") {
                  continue;
                }

                const [x, y] = glow ? [6, 60] : [80, 60];
                const thin = draw(view, filter, paint, 1);
                const plain = draw(view, filter, (d) => rect(d, pn === "hatching" ? 0 : 20, 0, pn === "hatching" ? 160 : 120, 120), coverage);
                results.push({ case: resolution + "x " + samples + " samples, " + pn + ", " + fn,
                  thin: thin(mid(x), mid(y)), plain: plain(mid(x), mid(y)) });
              }
            }

            // A shadow of no passes hiding its object: the object's alpha, edges antialiased.
            const disc = (d) => d.drawRoundRect(80 - 30.3, 60 - 30.3, 60.6, 60.6, 60.6, 60.6);
            const shadow = { ...filterDefaults("dropShadow"), blurX: 64, blurY: 64, quality: 0, distance: 0, hideObject: true, color: 0xffffff };
            const shadowed = draw(view, shadow, disc, 1);
            const bare = draw(view, null, disc, 1);
            let worst = 0;
            for (let y = 0; y < Math.round(120 * resolution); y++) {
              for (let x = 0; x < Math.round(160 * resolution); x++) {
                worst = Math.max(worst, Math.abs(shadowed(x, y) - bare(x, y)));
              }
            }

            results.push({ case: resolution + "x " + samples + " samples, zero-pass shadow's edge", thin: worst, plain: 0, most: 65 });
          } finally {
            view.destroy();
          }
        }
      }
    } finally {
      tessellator.dispose();
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
  if (Math.abs(r.thin - r.plain) > (r.most ?? 4)) {
    bad.push(`${r.case}: ${r.thin}, as a fill ${r.plain}`);
  }
}

assert.deepEqual(bad, [], "thin geometry blurred as bright as its coverage");
console.log(`filter-coverage: ${(value as Result[]).length} cases ok`);
