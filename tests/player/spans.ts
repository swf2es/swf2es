// Spans (docs/renderer.md, "Spans"): a scene that changes as flags say draws
// as a fresh view draws a twin of it, and passes the checked mode, through
// BitmapData.draw's passes between frames, a context lost and given back, a
// mask given mid-run, a container moved between parents that stand alike, a
// hidden video playing and two views of one display list; a span made stale
// on purpose, by a change no flag tells of, is caught, the error naming the
// object and the difference.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<string[]>(`(async () => {
  const { RenderView } = await import('@swf2es/player/scene');
  const { Container, ShapeObject, CONTENT, TRANSFORM } = await import('/player/display/display.js');
  const { PIXELS } = await import('/player/display/displayobject.js');
  const { Drawing } = await import('/player/display/drawing.js');
  // One tessellator for every view: each view's own makes wasm instances, freed only as the page
  // collects them, and fills went missing once a page had made many views.
  const { Tessellator } = await import('@swf2es/native/render');
  const tessellator = new Tessellator();
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
  // Four clips of four shapes in a group, under a root, after a lead clip whose length moves where
  // the group's draws lie in the list.
  const scene = () => {
    const root = new Container();
    const lead = new Container();
    lead.name = 'lead';
    const group = new Container();
    group.name = 'group';
    root.addChildAt(lead, 0);
    root.addChildAt(group, 1);
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
      group.addChildAt(clip, i);
      clips.push(clip);
    }

    return { root, lead, group, clips };
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
  const make = (checked) =>
    new RenderView({ width: 64, height: 64, checked, preserveDrawingBuffer: true, fillTessellator: tessellator.tessellate });
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
    ['still once more', () => {}],
    // The group, taken whole, moved down the list as the lead grows.
    ['the lead grows', (s) => { const shape = new ShapeObject(null); shape.drawing = drawing(0xff4000ff, 50); shape.invalidate(CONTENT); s.lead.addChildAt(shape, 0); }],
    ['grown, still', () => {}],
    // A part of a clip that stood still inside the group taken whole: the clip's and its siblings'
    // spans are found where the group's copies moved them.
    ['a shape in a still clip', (s) => { s.clips[1].children[2].drawing = drawing(0xff0080ff, 22); s.clips[1].children[2].invalidate(CONTENT); }],
    // That clip, walked, then carried down the list in the group taken whole, then changed again:
    // its parts are found where both the group's copies and the clip's place in it put them.
    ['the lead grows again', (s) => { const shape = new ShapeObject(null); shape.drawing = drawing(0xff6000ff, 56); shape.invalidate(CONTENT); s.lead.addChildAt(shape, 0); }],
    ['grown again, still', () => {}],
    ['another shape in that clip', (s) => { s.clips[1].children[0].drawing = drawing(0xff00a0ff, 2); s.clips[1].children[0].invalidate(CONTENT); }],
    ['a clip given a child', (s) => { const shape = new ShapeObject(null); shape.drawing = drawing(0xff2040ff, 40); shape.invalidate(CONTENT); s.clips[2].addChildAt(shape, 0); }],
    // A child moved to another parent walked the frame before, unflagged itself.
    ['two clips touched', (s) => { s.clips[0].children[1].invalidate(CONTENT); s.clips[2].children[1].invalidate(CONTENT); }],
    ['a shape moved to another clip', (s) => { const shape = s.clips[2].children[3]; s.clips[2].removeChild(shape); s.clips[0].addChildAt(shape, 0); }],
    ['moved, still', () => {}],
    // A clip's parts changed while it was hidden, which a hidden walk only clears the flags of.
    ['a clip hidden', (s) => { s.clips[2].visible = false; s.clips[2].invalidate(TRANSFORM); }],
    ['hidden, a part drawn anew', (s) => { s.clips[2].children[1].drawing = drawing(0xff80ffff, 14); s.clips[2].children[1].invalidate(CONTENT); }],
    ['the clip shown', (s) => { s.clips[2].visible = true; s.clips[2].invalidate(TRANSFORM); }],
    ['shown, still', () => {}],
  ];
  for (const checked of [true, false]) {
    const view = make(checked);
    // The spans a render takes whole (RenderView.copySpan), of what a frame did not change.
    const copySpan = view.copySpan;
    let copied = 0;
    view.copySpan = function (...args) {
      copied++;
      return copySpan.apply(this, args);
    };
    try {
      const s = scene();
      const twin = scene();
      for (const [k, [name, step]] of steps.entries()) {
        step(s);
        step(twin);
        copied = 0;
        const error = thrown(() => view.render(s.root));
        if (error) failures.push(checked + ', ' + name + ': threw ' + error);
        same(checked + ', ' + name, view, s, twin);
        // The first frame writes no span, the second the first ones; from the third, each frame
        // takes those of what it did not change, those under one taken whole the frame before too.
        if (k >= 2 && copied === 0) failures.push(checked + ', ' + name + ': took no span');
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
      if (view.spans.ended !== false) failures.push(checked + ': a context given back kept its spans');
      for (const name of ['restored', 'restored, still']) {
        const error = thrown(() => view.render(s.root));
        if (error) failures.push(checked + ', ' + name + ': threw ' + error);
        same(checked + ', ' + name, view, s, twin);
      }

      // A shape drawn anew with no flag set: its span, and its clip's, are stale.
      const changed = s.clips[0].children[2];
      changed.drawing = drawing(0xffff0000, 30);
      const stale = thrown(() => view.render(s.root));
      if (checked) {
        if (!stale || !stale.includes('the span of root (Container) is stale, first at root.group.clip0.' + changed.name + ' (ShapeObject)') || !/entry \\d+ of the span/.test(stale)) {
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
        if (!untold || !/root\\.group\\.clip3\\.shape3 \\(ShapeObject\\)/.test(untold) || !/changed/.test(untold)) {
          failures.push('untold change not caught: ' + untold);
        }
      } else if (untold) {
        failures.push('unchecked view threw ' + untold);
      }
    } finally {
      view.destroy();
    }
  }

  // A container moved between two parents that stand alike, after a frame that carried one and
  // not the other: both were walked in one frame and taken whole since, the second carried down
  // the list as a sibling between them grew. The mover's span lay in its old parent's, so its
  // children's are not where the new parent's copy moved its own.
  const parents = () => {
    const shape = (color, x, y) => {
      const s = new ShapeObject(null);
      s.drawing = drawing(color, x);
      s.matrix.ty = y;
      s.invalidate(CONTENT);
      return s;
    };
    const container = (name, children) => {
      const c = new Container();
      c.name = name;
      for (const [k, child] of children.entries()) c.addChildAt(child, k);
      return c;
    };
    const p = container('p', [shape(0xff0000ff, 0, 0), shape(0xff0040ff, 12, 0)]);
    const g1 = container('g1', [p]);
    const x = container('x', [shape(0xff00ff00, 0, 24)]);
    const g2 = container('g2', [shape(0xffff0000, 0, 44)]);
    const root = container('root', [g1, x, g2]);
    return { root, g1, x, g2, p, shape };
  };
  const moves = [
    ['first', () => {}],
    ['still', () => {}],
    ['a sibling between grows', (s) => { s.x.addChildAt(s.shape(0xff00ffff, 30, 24), 0); }],
    ['a container moved to a parent standing alike', (s) => { s.g1.removeChild(s.p); s.g2.addChildAt(s.p, 1); }],
    ['moved, still', () => {}],
    ['moved, still again', () => {}],
  ];
  for (const checked of [true, false]) {
    const view = make(checked);
    try {
      const s = parents();
      const twin = parents();
      for (const [name, step] of moves) {
        step(s);
        step(twin);
        const error = thrown(() => view.render(s.root));
        if (error) failures.push('moved, ' + checked + ', ' + name + ': threw ' + error);
        same('moved, ' + checked + ', ' + name, view, s, twin);
      }
    } finally {
      view.destroy();
    }
  }

  // A video playing inside a hidden container flags itself and its ancestors up to the hidden one
  // only (VideoObject.pixelsChanged), so as not to wake the stage: the container's parent, taken
  // whole as something else changes, holds a flagged object that draws nothing.
  for (const checked of [true, false]) {
    const view = make(checked);
    const copySpan = view.copySpan;
    let copied = 0;
    view.copySpan = function (...args) {
      copied++;
      return copySpan.apply(this, args);
    };
    try {
      const hiddenVideo = () => {
        const s = scene();
        const hidden = new Container();
        hidden.name = 'hidden';
        const video = new ShapeObject(null);
        video.name = 'video';
        video.drawing = drawing(0xffff00ff, 40);
        video.invalidate(CONTENT);
        hidden.addChildAt(video, 0);
        hidden.visible = false;
        s.clips[3].addChildAt(hidden, 0);
        return { ...s, hidden, video };
      };
      const s = hiddenVideo();
      const twin = hiddenVideo();
      for (let f = 0; f < 5; f++) {
        if (f >= 2) {
          for (const t of [s, twin]) {
            t.video.dirty |= PIXELS;
            t.hidden.descendantsDirty = true;
            t.clips[0].matrix.tx = f;
            t.clips[0].invalidate(TRANSFORM);
          }
        }

        copied = 0;
        const error = thrown(() => view.render(s.root));
        if (error) failures.push('hidden video, ' + checked + ', frame ' + f + ': threw ' + error);
        same('hidden video, ' + checked + ', frame ' + f, view, s, twin);
        if (f >= 2 && copied === 0) failures.push('hidden video, ' + checked + ', frame ' + f + ': took no span');
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
