// The view's checked mode (docs/renderer.md, "Spans"): a scene that changes
// as flags say passes it, and a span made stale on purpose, by a change no
// flag tells of, is caught, the error naming the object and the difference.
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
  for (const checked of [true, false]) {
    const view = new RenderView({ width: 64, height: 64, checked });
    try {
      const { root, clips } = scene();
      // Changes the flags tell of: a clip moved, a shape drawn anew, one taken out.
      const steps = [
        () => {},
        () => {},
        () => { clips[1].matrix.tx = 3; clips[1].invalidate(TRANSFORM); },
        () => { clips[2].children[1].drawing = drawing(0xff00ff00, 12); clips[2].children[1].invalidate(CONTENT); },
        () => { clips[3].removeChild(clips[3].children[0]); },
        () => {},
      ];
      for (const [i, step] of steps.entries()) {
        step();
        const error = thrown(() => view.render(root));
        if (error) failures.push(checked + ': step ' + i + ' threw ' + error);
      }

      // A shape drawn anew with no flag set: its span, and its clip's, are stale.
      clips[0].children[2].drawing = drawing(0xffff0000, 30);
      const stale = thrown(() => view.render(root));
      if (checked) {
        if (!stale || !/the span of root\\.clip0 \\(Container\\) is stale|the span of root\\.clip0\\.shape2 \\(ShapeObject\\) is stale/.test(stale) || !/entry 0 of the span/.test(stale)) {
          failures.push('stale span not caught as it should be: ' + stale);
        }
      } else if (stale) {
        failures.push('unchecked view threw ' + stale);
      }

      // A shape marked changed while its clip is not told: what descendantsDirty promises broken.
      const { root: other, clips: others } = scene();
      view.render(other);
      view.render(other);
      others[3].children[3].dirty |= CONTENT;
      const untold = thrown(() => view.render(other));
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

  return failures;
})()`),
);
assert.equal(exception, null, exception ?? "browser exception");
assert.deepEqual(value, []);
console.log("spans' checked mode: ok");
