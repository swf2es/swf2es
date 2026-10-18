// Advanced text's outlines and builds (render/saffron.ts): what the shader
// is given to go through, and when a text is drawn as normal text instead.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { type Glyph, readFont, tags } from "../../../../packages/format/dist/index.js";
import {
  chordsOf,
  FIELD_BUDGET,
  GLYPH_MOST,
  resetSegments,
  SaffronBuilder,
  SaffronView,
  segmentsUsed,
} from "../../../../packages/player/dist/render/saffron.js";
import { font3 } from "../../../swf-writer.ts";

// Pixi's RendererType: WebGL 1, WebGPU 2.
const WEBGL = 1;
const WEBGPU = 2;

const renderer = (type: number, version?: number) =>
  ({ type, context: { webGLVersion: version } }) as unknown as ConstructorParameters<
    typeof SaffronView
  >[0];

/** A DefineFont3 of the given glyphs, read back. */
function glyphs(spec: Parameters<typeof font3>[0]["glyphs"]): Glyph[] {
  const bytes = font3({ id: 1, name: "T", ascent: 900, descent: 250, glyphs: spec });
  // A long tag header: two bytes of code and length, four of length.
  return readFont(bytes, {
    code: tags.DefineFont3,
    offset: 6,
    length: bytes.length - 6,
    long: true,
  }).glyphs;
}

const [box] = glyphs([{ char: "a", advance: 500, boxes: [[0, -700, 400, 0]] }]);
const TABLE = [8, 0.1, -0.8, 27, 0.35, -0.85];
const TABLES = [TABLE, TABLE] as const;
const builder = (scale = 1, again = () => {}) =>
  new SaffronBuilder(new SaffronView(renderer(WEBGL, 2), false), 0, 0, 0, scale, again);

/** A glyph of a curve: a box whose top is a quadratic `bend` units high, in DefineFont3's units. */
function curved(bend: number): Glyph {
  const [top] = glyphs([{ char: "c", advance: 500, boxes: [[0, -700, 400, 0]] }]);
  const records: Glyph["records"] = top.records.filter((r) => r.type === "style");
  // From the top left corner, clockwise: a curve to the top right, then down, left and up.
  records.push(
    { type: "curve", cx: 4000, cy: -bend, ax: 4000, ay: bend },
    { type: "line", dx: 0, dy: 14000 },
    { type: "line", dx: -8000, dy: 0 },
    { type: "line", dx: 0, dy: -14000 },
  );
  return { ...top, records };
}

test("a glyph of boxes is its edges, a curve its chords, fewer as the tolerance grows", () => {
  assert.equal(chordsOf(box, 1).length / 4, 4);

  const glyph = curved(4000);
  const fine = chordsOf(glyph, 1024 / 8192).length / 4 - 3;
  const coarse = chordsOf(glyph, 1024 / 2048).length / 4 - 3;
  assert.ok(fine > coarse && coarse >= 1, `${fine} chords fine, ${coarse} coarse`);
  // Each a nth of the curve, n the least whose chords stray by the tolerance at most.
  const bend = Math.hypot(0, 2 * 200) / 1;
  assert.equal(coarse, Math.ceil(Math.sqrt(bend / (4 * 0.5))));
});

test("a glyph of more segments than the shader may go through is drawn as normal text", () => {
  resetSegments();
  // A zigzag of more edges than that, closed.
  const [plain] = glyphs([{ char: "z", advance: 500, boxes: [[0, -700, 400, 0]] }]);
  const records: Glyph["records"] = plain.records.filter((r) => r.type === "style");
  for (let i = 0; i < GLYPH_MOST + 1000; i++) {
    records.push({ type: "line", dx: 1, dy: i % 2 ? 40 : -40 });
  }

  records.push({ type: "line", dx: -(GLYPH_MOST + 1000), dy: 0 });
  const many: Glyph = { ...plain, records };

  const b = builder();
  assert.equal(b.reserve(many, 20480, 20, TABLES), false);
  assert.equal(segmentsUsed(), 0);
  // Known: not cut again.
  assert.equal(b.reserve(many, 20480, 20, TABLES), false);
  assert.equal(segmentsUsed(), 0);
  assert.equal(b.reserve(box, 20480, 20, TABLES), true);
});

test("a field that would ask more of the shader than its budget is drawn as normal text", () => {
  // A box of 4 segments at 20 pixels, scaled up until its quad's pixels past the budget.
  assert.equal(builder(1).reserve(box, 20480, 20, TABLES), true);
  const side = Math.sqrt(FIELD_BUDGET / 4);
  assert.equal(builder(side / 10).reserve(box, 20480, 20, TABLES), false);

  // Or many glyphs together.
  const b = builder(4);
  let fits = 0;
  while (fits < 100000 && b.reserve(box, 20480, 20, TABLES)) {
    fits++;
  }
  assert.ok(fits > 10 && fits < 100000, `${fits} glyphs fit`);
});

test("the store starting again draws again the texts drawn from it, and they go through it again", async (t) => {
  // Pixi as the player loads it; node has no canvas, whose WebGL a program asks its precision of.
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = (await import(entry)) as {
    DOMAdapter: { get(): object; set(adapter: object): void };
  };
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  t.after(() => pixi.DOMAdapter.set(adapter));
  resetSegments();
  let again = 0;
  const b = builder(1, () => again++);
  assert.equal(b.reserve(box, 20480, 20, TABLES), true);
  assert.equal(b.intact(), true);
  assert.equal(b.add(box, 20480, 0, 0, 20, 0, 1, TABLES), true);
  const text = b.done();
  assert.ok(text);
  assert.equal(segmentsUsed(), 4);

  resetSegments();
  assert.equal(again, 1);
  assert.equal(text.visible, false);
  assert.equal(segmentsUsed(), 0);
  assert.equal(b.intact(), false);

  b.restart();
  assert.equal(b.reserve(box, 20480, 20, TABLES), true);
  assert.equal(b.intact(), true);
  assert.equal(segmentsUsed(), 4);
  text.destroy();
});

test("tables take their places in the uniforms, coded as first entry plus 64 times their entries", () => {
  const b = builder();
  const other = [10, 0.5, -0.5];
  assert.equal(b.code(TABLE), 0 + 2 * 64);
  assert.equal(b.code(other), 2 + 1 * 64);
  assert.equal(b.code(TABLE), 0 + 2 * 64);
  // 48 entries at most.
  const big = Array.from({ length: 46 * 3 }, (_, i) => i);
  assert.equal(b.code(big), -1);
  assert.equal(b.code(big.slice(0, 45 * 3)), 3 + 45 * 64);
});

test("advanced text is drawn only by WebGL 2, its shader being GLSL ES 3.0", () => {
  assert.equal(new SaffronView(renderer(WEBGL, 2), false).enabled, true);
  assert.equal(new SaffronView(renderer(WEBGL, 1), false).enabled, false);
  assert.equal(new SaffronView(renderer(WEBGPU), false).enabled, false);
});
