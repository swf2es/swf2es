// Spans (docs/renderer.md, "Spans"): a scene that changes as flags say draws
// as a fresh view draws a twin of it, and passes the checked mode, through
// BitmapData.draw's passes between frames, a context lost and given back, a
// mask given mid-run and two views of one display list; a span made stale on
// purpose, by a change no flag tells of, is caught, the error naming the
// object and the difference.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<string[]>(`(async () => {
  const { RenderView } = await import('@swf2es/player/scene');
  const { Container, ShapeObject, CONTENT, TRANSFORM } = await import('/player/display/display.js');
  const { Drawing } = await import('/player/display/drawing.js');
  const drawing = (color, x) => {
    const d = new Drawing();
    d.beginFill({ type: 'solid', color });
    d.drawRect(x, 4, 8, 8);
    d.endFill();
    d.lineStyle({ width: 20, color: 0xff000000, startCap: 0, endCap: 0, join: 0, miterLimit: 3,
      noHScale: false, noVScale: false, pixelHinting: false, noClose: false, fill: null });
    d.moveTo(x, 16);
    d.curveTo(x + 4, 24, x + 8, 16);
    return d;
  };
  // Four clips of four shapes, under a root.
  const scene = () => {
    const root = new Container();
    const clips = [];
    for (let i = 0; i < 4; i++) {
      const clip = new Container();
      clip.name = 'clip' + i;
      for (let k = 0; k < 4; k++) {
        const shape = new ShapeObject(null);
        shape.name = 'shape' + k;
        shape.drawing = drawing(0xff0000ff + k * 0x3000, k * 10);
        shape.invalidate(CONTENT);
        clip.addChildAt(shape, k);
      }

      clip.matrix.ty = i * 16;
      clip.invalidate(TRANSFORM);
      root.addChildAt(clip, i);
      clips.push(clip);
    }

    return { root, clips };
  };
  const failures = [];
  const thrown = (f) => {
    try {
      f();
      return null;
    } catch (e) {
      return String(e?.message ?? e);
    }
  };
  const pixels = (view) => {
    const gl = view.gl;
    const out = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const make = (checked) => new RenderView({ width: 64, height: 64, checked, preserveDrawingBuffer: true });
  // Drawn by \`view\`, \`s\` as a fresh view draws \`twin\`, which took the same steps.
  const same = (label, view, s, twin) => {
    const fresh = make(false);
    try {
      fresh.render(twin.root);
      const a = pixels(view);
      const b = pixels(fresh);
      if (a.some((v, k) => v !== b[k])) failures.push(label + ': draws otherwise than a fresh view');
      if (!a.some((v, k) => k % 4 === 2 && v > 128 && a[k - 2] < 128)) failures.push(label + ': drew no blue');
    } finally {
      fresh.destroy();
    }
  };
  // Resolved as \`event\` comes to \`view\`'s canvas, or after 10 s as a failure, so a missed one cannot hang the run.
  const event = (view, name) => new Promise((done) => {
    const timer = setTimeout(() => { failures.push('no ' + name); done(); }, 10000);
    view.canvas.addEventListener(name, () => { clearTimeout(timer); setTimeout(done, 0); }, { once: true });
  });
  const I = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  // What a scene goes through, a step a frame, each taken by the scene and its twin alike.
  const steps = [
    ['first', () => {}],
    ['still', () => {}],
    ['a clip moved', (s) => { s.clips[1].matrix.tx = 3; s.clips[1].invalidate(TRANSFORM); }],
    ['a shape drawn anew', (s) => { s.clips[2].children[1].drawing = drawing(0xff00ff00, 12); s.clips[2].children[1].invalidate(CONTENT); }],
    ['a shape taken out', (s) => { s.clips[3].removeChild(s.clips[3].children[0]); }],
    ['still again', () => {}],
    // A later clip made the mask of an earlier one: the mask walker clears its flags first.
    ['a mask given', (s) => { s.clips[0].setMask(s.clips[3]); }],
    ['masked, still', () => {}],
    ['the mask taken back', (s) => { s.clips[0].setMask(null); }],
    ['unmasked, still', () => {}],
  ];
  for (const checked of [true, false]) {
    const view = make(checked);
    try {
      const s = scene();
      const twin = scene();
      for (const [name, step] of steps) {
        step(s);
        step(twin);
        const error = thrown(() => view.render(s.root));
        if (error) failures.push(checked + ', ' + name + ': threw ' + error);
        same(checked + ', ' + name, view, s, twin);
      }

      // BitmapData.draw between frames, of another list and of a part of this one: its passes must
      // not write over the frame before's list, which the spans name.
      const other = scene();
      other.clips[0].matrix.tx = 7;
      other.clips[0].invalidate(TRANSFORM);
      for (const [name, draw] of [['other', other.root], ['own part', s.clips[2]]]) {
        view.snapshot(draw, I, 64, 64, 1);
        const error = thrown(() => view.render(s.root));
        if (error) failures.push(checked + ', after a draw of ' + name + ': threw ' + error);
        same(checked + ', after a draw of ' + name, view, s, twin);
      }

      // A context lost and given back drops every span.
      const ext = view.gl.getExtension('WEBGL_lose_context');
      const gone = event(view, 'webglcontextlost');
      ext.loseContext();
      await gone;
      const back = event(view, 'webglcontextrestored');
      ext.restoreContext();
      await back;
      if (checked && view.spans?.ended !== false) failures.push('a context given back kept its spans');
      for (const name of ['restored', 'restored, still']) {
        const error = thrown(() => view.render(s.root));
        if (error) failures.push(checked + ', ' + name + ': threw ' + error);
        same(checked + ', ' + name, view, s, twin);
      }

      // A shape drawn anew with no flag set: its span, and its clip's, are stale.
      s.clips[0].children[2].drawing = drawing(0xffff0000, 30);
      const stale = thrown(() => view.render(s.root));
      if (checked) {
        if (!stale || !/the span of root\\.clip0 \\(Container\\) is stale|the span of root\\.clip0\\.shape2 \\(ShapeObject\\) is stale/.test(stale) || !/entry 0 of the span/.test(stale)) {
          failures.push('stale span not caught as it should be: ' + stale);
        }
      } else if (stale) {
        failures.push('unchecked view threw ' + stale);
      }

      // A shape marked changed while its clip is not told: what descendantsDirty promises broken.
      const untoldScene = scene();
      view.render(untoldScene.root);
      view.render(untoldScene.root);
      untoldScene.clips[3].children[3].dirty |= CONTENT;
      const untold = thrown(() => view.render(untoldScene.root));
      if (checked) {
        if (!untold || !/root\\.clip3\\.shape3 \\(ShapeObject\\)/.test(untold) || !/changed/.test(untold)) {
          failures.push('untold change not caught: ' + untold);
        }
      } else if (untold) {
        failures.push('unchecked view threw ' + untold);
      }
    } finally {
      view.destroy();
    }
  }

  // Two views of one display list, each walk clearing flags the other's spans follow.
  const first = make(true);
  const second = make(true);
  try {
    const s = scene();
    const twin = scene();
    for (const [name, step] of steps) {
      step(s);
      step(twin);
      for (const [which, view] of [['first', first], ['second', second]]) {
        const error = thrown(() => view.render(s.root));
        if (error) failures.push('two views, ' + which + ', ' + name + ': threw ' + error);
        same('two views, ' + which + ', ' + name, view, s, twin);
      }
    }
  } finally {
    first.destroy();
    second.destroy();
  }

  return failures;
})()`),
);
assert.equal(exception, null, exception ?? "browser exception");
assert.deepEqual(value, []);
console.log("spans: ok");
