// The glyph quad must cover everything its distance shader can draw.
// Compare it with an oversized quad over the same outline: that reference
// cannot clip its coverage, including where Flash uses normal antialiasing.
import assert from "node:assert/strict";
import { readFont, tags } from "../../packages/format/dist/index.js";
import { font3 } from "../swf-writer.ts";
import { withPage } from "./chrome.ts";

const font = font3({
  id: 1,
  name: "Box",
  ascent: 900,
  descent: 250,
  glyphs: [{ char: "a", advance: 600, boxes: [[0, -700, 500, 0]] }],
});
const [glyph] = readFont(font, {
  code: tags.DefineFont3,
  offset: 6,
  length: font.length - 6,
  long: true,
}).glyphs;

await withPage("runSwf", async (evaluate) => {
  const result = await evaluate<{ draws: number; different: number; worst: number }>(`(async () => {
    const { autoDetectRenderer, Container, Matrix } = await import("pixi.js");
    const { SaffronBuilder, SaffronView } = await import("/player/render/saffron.js");
    const renderer = await autoDetectRenderer({
      width: 128, height: 128, preference: "webgl", preferWebGLVersion: 2,
      antialias: false, backgroundAlpha: 0, preserveDrawingBuffer: true
    });
    const stage = new Container();
    const view = new SaffronView(renderer, false);
    if (!view.enabled) { throw new Error("advanced text needs WebGL 2"); }
    const glyph = ${JSON.stringify(glyph)};
    const table = [6, 0.4, -0.8, 32, 0.4, -0.8];
    const transforms = [
      [1, 0, 0, 1], [-1, 0, 0, 1], [1, 0, 0, -1], [-1, 0, 0, -1],
      [0, 1, -1, 0], [-0.8, -0.6, -0.6, 0.8], [-1, 0.2, 0.4, 1]
    ];
    const gl = renderer.gl;
    const pixels = () => {
      renderer.render({ container: stage, clear: true });
      const data = new Uint8Array(128 * 128 * 4);
      gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    };
    let draws = 0, different = 0, worst = 0;
    try {
      for (let s = 0; s < 3; s++) {
        const size = [6, 12, 32][s];
        for (let t = 0; t < transforms.length; t++) {
          const builder = new SaffronBuilder(view, 0, 0, 0, 1, () => {});
          if (!builder.reserve(glyph, 20480, size, [table, table]) ||
              !builder.add(glyph, 20480, 0, 0, size, 0xffffff, 1, [table, table])) {
            throw new Error("glyph did not fit");
          }
          const mesh = builder.done();
          mesh.setFromMatrix(new Matrix(...transforms[t], 64, 64));
          stage.addChild(mesh);
          const actual = pixels();
          const buffer = mesh.geometry.getBuffer("aGlyph");
          const data = buffer.data;
          for (let at = 0; at < data.length; at += 18) {
            data[at + 6] += data[at + 8] * 4096;
            data[at + 7] += data[at + 9] * 4096;
          }
          buffer.update();
          const expected = pixels();
          if (!expected.some((v) => v > 0)) { throw new Error("empty reference"); }
          for (let i = 0; i < actual.length; i++) {
            const delta = Math.abs(actual[i] - expected[i]);
            if (delta > 1) { different++; }
            worst = Math.max(worst, delta);
          }
          stage.removeChild(mesh);
          mesh.destroy();
          draws++;
        }
      }
      return { draws, different, worst };
    } finally {
      stage.destroy();
      renderer.destroy();
    }
  })()`);
  assert.ok(result.value, JSON.stringify(result));
  assert.equal(result.value.draws, 21);
  assert.equal(result.value.different, 0, JSON.stringify(result.value));
});
console.log("advanced text: 21 reflected, rotated and skewed glyph quads cover their shader");
