// Fuzzes spans (docs/renderer.md, "Spans") with random changes to a tree of
// containers and shapes, made as the player makes them, flags and all:
// moves, shapes drawn anew, added, removed and moved to another parent,
// containers moved to another parent or place, hidden and shown, coloured,
// masked and unmasked, cached as bitmaps, blended, drawn by BitmapData.draw,
// and the view's scale and viewport changed. Each frame, the view that keeps
// spans must
//
//   - not throw, which with the checked mode (odd seeds) means each span it
//     took matched a walk of its object;
//   - draw what a view that takes no span draws of a twin of the tree, which
//     took the same steps (even seeds too, where nothing is checked);
//
// and at each seed's end, what a fresh view draws of the twin. The steps are
// seeded, so a run repeats exactly; a failure names its seed, its frame and
// the steps before it:
//
//   node tests/player/spans-fuzz.ts [seeds, 60] [first seed, 1] [frames, 40]
//
// Many short runs rather than a few long ones: what breaks a span takes parents that stand alike,
// walked in one frame and taken whole since, which a tree drifts away from as it is changed.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const seeds = Number(process.argv[2] ?? 60);
const firstSeed = Number(process.argv[3] ?? 1);
const frames = Number(process.argv[4] ?? 40);

const { value, exception } = await withPage(
  "runSwf",
  (evaluate) =>
    evaluate<string[]>(`(async () => {
  const { RenderView } = await import('@swf2es/player/scene');
  const { Container, ShapeObject, CONTENT, TRANSFORM } = await import('/player/display/display.js');
  const { Drawing } = await import('/player/display/drawing.js');
  // One tessellator for every view: each view's own makes wasm instances, freed only as the page
  // collects them, and fills went missing once a page had made many views.
  const { Tessellator } = await import('@swf2es/native/render');
  const tessellator = new Tessellator();
  const SIZE = 64;
  const drawing = (color, x, y, line) => {
    const d = new Drawing();
    d.beginFill({ type: 'solid', color });
    d.drawRect(x, y, 8, 8);
    d.endFill();
    if (line) {
      d.lineStyle({ width: 20, color: 0xff000000, startCap: 0, endCap: 0, join: 0, miterLimit: 3,
        noHScale: false, noVScale: false, pixelHinting: false, noClose: false, fill: null });
      d.moveTo(x, y + 12);
      d.curveTo(x + 4, y + 20, x + 8, y + 12);
    }

    return d;
  };
  const make = (checked) =>
    new RenderView({ width: SIZE, height: SIZE, checked, preserveDrawingBuffer: true, fillTessellator: tessellator.tessellate });
  const pixels = (view) => {
    const gl = view.gl;
    const out = new Uint8Array(SIZE * SIZE * 4);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const differing = (a, b) => {
    let n = 0;
    for (let k = 0; k < a.length; k++) {
      if (a[k] !== b[k]) n++;
    }

    return n;
  };
  const inside = (o, a) => {
    for (let p = o; p; p = p.parent) {
      if (p === a) return true;
    }

    return false;
  };

  // A tree, and its twin: each step is drawn from the generator once and taken by both, which hold
  // their containers and shapes in the same order.
  const tree = () => {
    const root = new Container();
    root.name = 'root';
    return { root, containers: [root], shapes: [] };
  };
  const addShape = (t, color, x, y, line) => {
    const s = new ShapeObject(null);
    s.name = 's' + t.shapes.length;
    s.drawing = drawing(color, x, y, line);
    s.invalidate(CONTENT);
    t.shapes.push(s);
    return s;
  };

  const fuzz = (seed) => {
    let state = seed >>> 0;
    const rnd = (n) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 4294967296) * n);
    };
    const checked = seed % 2 === 1;
    const view = make(checked);
    // Its spans dropped before each frame, so that it walks all of the twin.
    const plain = make(false);
    const log = [];
    const a = tree();
    const b = tree();
    const both = (f) => {
      f(a, view);
      f(b, plain);
    };
    try {
      for (let i = 0; i < 10; i++) {
        const at = rnd(i + 1);
        const n = 1 + rnd(3);
        const shapes = [];
        for (let k = 0; k < n; k++) {
          shapes.push([0xff000000 | rnd(0xffffff), rnd(50), rnd(40), rnd(2) === 0]);
        }

        both((t) => {
          const c = new Container();
          c.name = 'c' + i;
          t.containers[at].addChildAt(c, t.containers[at].children.length);
          t.containers.push(c);
          for (const [color, x, y, line] of shapes) {
            c.addChildAt(addShape(t, color, x, y, line), c.children.length);
          }
        });
      }

      for (let f = 0; f < ${frames}; f++) {
        const ops = rnd(3);
        for (let k = 0; k < ops; k++) {
          // Reparenting weighs most, and what makes a subtree draw by more than its spans (masks,
          // caches, blends), or nothing (hidden), is undone more readily than done, so that most of
          // the tree stays plain and drawn.
          const op = rnd(20);
          const ci = 1 + rnd(a.containers.length - 1);
          const si = rnd(a.shapes.length);
          const c = a.containers[ci];
          const s = a.shapes[si];
          switch (op) {
            case 0:
            case 16: {
              // Back to where it began as often as away, so that many containers stand alike.
              const tx = rnd(3) === 0 ? 1 + rnd(2) : 0;
              both((t) => {
                const o = t.containers[ci];
                o.matrix = { ...o.matrix, tx };
                o.invalidate(TRANSFORM);
              });
              log.push(f + ' move ' + c.name);
              break;
            }
            case 1: {
              const args = [0xff000000 | rnd(0xffffff), rnd(50), rnd(40), rnd(2) === 0];
              both((t) => {
                t.shapes[si].drawing = drawing(...args);
                t.shapes[si].invalidate(CONTENT);
              });
              log.push(f + ' redraw ' + s.name);
              break;
            }
            case 2: {
              const args = [0xff000000 | rnd(0xffffff), rnd(50), rnd(40), rnd(2) === 0];
              const at = rnd(c.children.length + 1);
              both((t) => t.containers[ci].addChildAt(addShape(t, ...args), at));
              log.push(f + ' add to ' + c.name);
              break;
            }
            case 3:
              if (s.parent) {
                both((t) => t.shapes[si].parent.removeChild(t.shapes[si]));
                log.push(f + ' remove ' + s.name);
              }
              break;
            case 4:
            case 5:
            case 17:
            case 18: {
              const ti = rnd(a.containers.length);
              const to = a.containers[ti];
              if (c.parent && !inside(to, c)) {
                const at = rnd(to.children.length + 1);
                both((t) => {
                  const o = t.containers[ci];
                  o.parent.removeChild(o);
                  t.containers[ti].addChildAt(o, Math.min(at, t.containers[ti].children.length));
                });
                log.push(f + ' reparent ' + c.name + ' to ' + to.name);
              }
              break;
            }
            case 6: {
              const ti = rnd(a.containers.length);
              const at = rnd(a.containers[ti].children.length + 1);
              both((t) => {
                const o = t.shapes[si];
                if (o.parent) o.parent.removeChild(o);
                t.containers[ti].addChildAt(o, Math.min(at, t.containers[ti].children.length));
              });
              log.push(f + ' reparent ' + s.name + ' to ' + a.containers[ti].name);
              break;
            }
            case 7:
              if (!c.visible || rnd(3) === 0) {
                both((t) => {
                  const o = t.containers[ci];
                  o.visible = !o.visible;
                  o.invalidate(TRANSFORM);
                });
                log.push(f + ' visible ' + c.name);
              }
              break;
            case 8: {
              const colour = rnd(3)
                ? null
                : { rMul: 1, gMul: rnd(2), bMul: 1, aMul: 1, rAdd: 0, gAdd: 0, bAdd: rnd(2) * 40, aAdd: 0 };
              both((t) => {
                const o = t.containers[ci];
                o.colorTransform = colour && { ...colour };
                o.invalidate(TRANSFORM);
              });
              log.push(f + ' colour ' + c.name);
              break;
            }
            case 9:
              if (c.parent) {
                const i = rnd(c.parent.children.length);
                both((t) => {
                  const o = t.containers[ci];
                  const parent = o.parent;
                  parent.removeChild(o);
                  parent.addChildAt(o, Math.min(i, parent.children.length));
                });
                log.push(f + ' reorder ' + c.name);
              }
              break;
            case 10:
              if (rnd(3) === 0) {
                const scale = 1 + rnd(2);
                both((_, v) => {
                  v.scale = scale;
                });
                log.push(f + ' scale ' + scale);
              }
              break;
            case 11:
              if (rnd(3) === 0) {
                const x = rnd(3);
                both((_, v) => v.setViewport(x, 0, SIZE, SIZE));
                log.push(f + ' viewport ' + x);
              }
              break;
            case 12: {
              const mi = 1 + rnd(a.containers.length - 1);
              const m = a.containers[mi];
              if (c.mask) {
                both((t) => t.containers[ci].setMask(null));
                log.push(f + ' unmask ' + c.name);
              } else if (rnd(3) === 0 && m !== c && !m.maskOf && !m.mask) {
                both((t) => t.containers[ci].setMask(t.containers[mi]));
                log.push(f + ' mask ' + c.name + ' by ' + m.name);
              }
              break;
            }
            case 13:
              if (c.cachedAsBitmap || rnd(3) === 0) {
                both((t) => t.containers[ci].setCachedAsBitmap(!t.containers[ci].cachedAsBitmap));
                log.push(f + ' cache ' + c.name);
              }
              break;
            case 14:
              if (c.blendMode !== 'normal' || rnd(3) === 0) {
                const mode = c.blendMode === 'normal' ? (rnd(2) ? 'add' : 'layer') : 'normal';
                both((t) => t.containers[ci].setBlendMode(mode));
                log.push(f + ' blend ' + c.name + ' ' + mode);
              }
              break;
            case 15:
              if (rnd(4) === 0) {
                both((t, v) => v.snapshot(t.containers[ci], { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, SIZE, SIZE, 1));
                log.push(f + ' snapshot ' + c.name);
              }
              break;
          }
        }

        const where = 'seed ' + seed + (checked ? ' (checked)' : '') + ', frame ' + f;
        const steps = ' | steps before: ' + log.slice(-8).join('; ');
        try {
          view.render(a.root);
        } catch (e) {
          return where + ': threw ' + (e?.message ?? e) + steps;
        }

        plain.spans.drop();
        plain.render(b.root);
        const n = differing(pixels(view), pixels(plain));
        if (n) return where + ': ' + n + ' bytes differ from a view that takes no span' + steps;
      }

      const fresh = make(false);
      try {
        fresh.scale = plain.scale;
        fresh.setViewport(plain.viewX, plain.viewY, SIZE, SIZE);
        fresh.render(b.root);
        const n = differing(pixels(view), pixels(fresh));
        if (n) return 'seed ' + seed + ': ' + n + ' bytes differ from a fresh view at the end | steps before: ' + log.slice(-8).join('; ');
      } finally {
        fresh.destroy();
      }

      return null;
    } finally {
      view.destroy();
      plain.destroy();
    }
  };

  const failures = [];
  for (let seed = ${firstSeed}; seed < ${firstSeed + seeds} && failures.length < 10; seed++) {
    const failure = fuzz(seed);
    if (failure) failures.push(failure);
  }

  return failures;
})()`),
  false,
  { args: ["--mute-audio"] },
);
assert.equal(exception, null, exception ?? "browser exception");
assert.deepEqual(value, []);
console.log(`spans fuzz: ${seeds} seeds from ${firstSeed}, ${frames} frames each, ok`);
