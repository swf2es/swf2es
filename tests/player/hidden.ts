// Hidden descendants and children of reused filter outputs still synchronize for
// subsequent draws. Revealing or changing them must match a fresh scene.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<string[]>(`(async () => {
  const { RenderView } = await import('@swf2es/player/scene');
  const { Container, ShapeObject, CONTENT, TRANSFORM } = await import('/player/display/display.js');
  const { Drawing } = await import('/player/display/drawing.js');
  const { filterDefaults } = await import('/player/display/filters.js');
  const view = new RenderView({ width: 64, height: 64, preserveDrawingBuffer: true });
  const gl = view.gl;
  const pixels = (root) => {
    view.render(root);
    const result = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, result);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL failed');
    return result;
  };
  const paint = (shape, color) => {
    shape.drawing = new Drawing();
    shape.drawing.beginFill({ type: 'solid', color });
    shape.drawing.drawRect(8, 8, 32, 32);
    shape.drawing.endFill();
    shape.invalidate(CONTENT);
  };
  const make = (filtered, color) => {
    const root = new Container(), parent = new Container(), nested = new Container();
    const shape = new ShapeObject(null);
    paint(shape, color);
    if (filtered) parent.filters = [{ ...filterDefaults('blur'), blurX: 4, blurY: 4, quality: 1 }];
    nested.addChildAt(shape, 0); parent.addChildAt(nested, 0); root.addChildAt(parent, 0);
    return {root, parent, nested, shape};
  };
  const failures = [];
  const equal = (a, b, name) => {
    if (a.some((v, i) => v !== b[i])) failures.push(name);
    if (!a.some((v, i) => i % 4 === 0 && (v !== a[i + 1] || v !== a[i + 2]))) failures.push(name + ': empty fixture');
  };
  try {
    for (const filtered of [false, true]) {
      const s = make(filtered, 0xffff0000);
      pixels(s.root);
      // Reuse a filter output, then hide its whole subtree.
      pixels(s.root);
      s.parent.visible = false; s.parent.invalidate(TRANSFORM);
      pixels(s.root);
      paint(s.shape, 0xff00ff00);
      pixels(s.root);
      if (s.nested.descendantsDirty || s.shape.dirty) failures.push('hidden dirty flags');
      s.parent.visible = true; s.parent.invalidate(TRANSFORM);
      equal(pixels(s.root), pixels(make(filtered, 0xff00ff00).root), 'revealed ' + filtered);
      pixels(s.root);
      s.parent.matrix.tx = 4; s.parent.invalidate(TRANSFORM);
      pixels(s.root);
      paint(s.shape, 0xff0000ff);
      const expected = make(filtered, 0xff0000ff);
      expected.parent.matrix.tx = 4;
      equal(pixels(s.root), pixels(expected.root), 'changed cached child ' + filtered);
    }
    return failures;
  } finally { view.destroy(); }
})()`),
);
assert.equal(exception, null, exception ?? "browser exception");
assert.deepEqual(value, []);
console.log("hidden subtree: ok");
