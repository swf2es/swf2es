import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Tessellator } from "@swf2es/native/render";
import type { DisplayObject } from "../../../../packages/player/dist/display/displayobject.js";
import { Drawing } from "../../../../packages/player/dist/display/drawing.js";
import { morphAt } from "../../../../packages/player/dist/display/morph.js";
import type { ShapeLayer } from "../../../../packages/player/dist/display/shapes.js";
import { LineCache } from "../../../../packages/player/dist/scene/lines.js";
import {
  type KeptPartsOptions,
  Parts,
  SLOW_PARTS_MS,
} from "../../../../packages/player/dist/scene/parts.js";
import { Geometries, IDLE_FRAMES } from "../../../../packages/render/dist/index.js";
import { crossingMorph } from "./crossing-morph.ts";

function drawing() {
  const d = new Drawing();
  d.beginFill({ type: "solid", color: 0xff0088ff });
  d.drawRect(0, 0, 20, 20);
  d.endFill();
  return d;
}

function fixture() {
  const tessellator = new Tessellator();
  const geometries = new Geometries();
  const parts = new Parts(
    geometries,
    tessellator.tessellate,
    new LineCache(geometries, tessellator.tessellate),
  );
  const d = drawing();
  return { tessellator, geometries, parts, d };
}

test("unchanged cached parts need no repeated handle validation, including after a frame", () => {
  const { tessellator, geometries, parts, d } = fixture();
  try {
    const first = parts.partsOf(d.layers[0], d.version);
    assert.ok(first.length > 0);
    let checks = 0;
    const alive = geometries.alive.bind(geometries);
    geometries.alive = (handle) => {
      checks++;
      return alive(handle);
    };
    for (let i = 0; i < 10; i++) {
      assert.equal(parts.partsOf(d.layers[0], d.version), first);
      geometries.endFrame();
    }
    assert.equal(checks, 0);

    // An unrelated removal revalidates once, without rebuilding these parts.
    const geometry = geometries.get(first[0].handle.id);
    assert.ok(geometry);
    const other = geometries.add(geometry);
    geometries.remove(other.id);
    assert.equal(parts.partsOf(d.layers[0], d.version), first);
    assert.equal(checks, first.length);
    assert.equal(parts.partsOf(d.layers[0], d.version), first);
    assert.equal(checks, first.length);
  } finally {
    tessellator.dispose();
  }
});

test("a removal and id reuse in the same frame cannot revive cached parts", () => {
  const { tessellator, geometries, parts, d } = fixture();
  try {
    const first = parts.partsOf(d.layers[0], d.version);
    const old = first[0].handle;
    const geometry = geometries.get(old.id);
    assert.ok(geometry);
    geometries.remove(old.id);
    const replacement = geometries.add(geometry);
    assert.equal(replacement.id, old.id);
    assert.notEqual(replacement.generation, old.generation);
    const next = parts.partsOf(d.layers[0], d.version);
    assert.notEqual(next, first);
    assert.ok(geometries.alive(next[0].handle));
    assert.ok(geometries.alive(replacement), "rebuild must not remove the id's new owner");
  } finally {
    tessellator.dispose();
  }
});

test("expiry, context loss, drawing versions and masks still invalidate independently", () => {
  const { tessellator, geometries, parts, d } = fixture();
  try {
    const layer = d.layers[0];
    let regular = parts.partsOf(layer, d.version);
    const mask = parts.partsOf(layer, d.version, true);
    assert.notEqual(regular, mask);
    for (let i = 0; i <= IDLE_FRAMES + 1; i++) {
      geometries.endFrame();
    }
    let next = parts.partsOf(layer, d.version);
    assert.notEqual(next, regular);
    assert.ok(next.every((p) => geometries.alive(p.handle)));
    regular = next;

    geometries.lost();
    next = parts.partsOf(layer, d.version);
    assert.notEqual(next, regular);
    assert.ok(next.every((p) => geometries.alive(p.handle)));
    assert.notEqual(parts.partsOf(layer, d.version, true), mask);
    regular = next;

    next = parts.partsOf(layer, d.version + 1);
    assert.notEqual(next, regular);
    assert.ok(regular.every((p) => !geometries.alive(p.handle)));
    assert.ok(next.every((p) => geometries.alive(p.handle)));
  } finally {
    tessellator.dispose();
  }
});

test("idle shape layers release their geometry buffers between visits", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const { tessellator, geometries, parts, d } = fixture();
  const layer = d.layers[0];
  try {
    const draw = (masking: boolean) => {
      const [{ handle }] = parts.partsOf(layer, d.version, masking);
      const geometry = geometries.get(handle.id);
      assert.ok(geometry && geometry.positions.byteLength > 0);
      return new WeakRef(geometry.positions.buffer);
    };
    const buffers: WeakRef<ArrayBufferLike>[] = [];
    const retained: number[] = [];

    for (let visit = 0; visit < 3; visit++) {
      buffers.push(draw(false), draw(true));

      for (let frame = 0; frame <= IDLE_FRAMES + 1; frame++) {
        geometries.endFrame();
      }

      assert.deepEqual(geometries.live(), []);
      // WeakRef keeps its target through this turn. Collect before revisiting the same layer.
      await setImmediate();
      gc();
      retained.push(buffers.filter((buffer) => buffer.deref() !== undefined).length);
    }

    assert.deepEqual(retained, [0, 0, 0], "expired geometry buffers retained after each visit");
  } finally {
    tessellator.dispose();
  }
});

/** Two squares 20 wide, the second at (`x`, `y`), in one layer of a drawing. */
function squares(x: number, y = 0): Drawing {
  const d = new Drawing();
  d.beginFill({ type: "solid", color: 0xff0088ff });
  d.drawRect(0, 0, 20, 20);
  d.beginFill({ type: "solid", color: 0xffff8800 });
  d.drawRect(x, y, 20, 20);
  d.endFill();
  return d;
}

/** `fixture`'s, with the tessellator's layer calls counted. */
function counting(kept: KeptPartsOptions = {}) {
  const tessellator = new Tessellator();
  const geometries = new Geometries();
  const calls = { layers: 0 };
  const tessellate = {
    layer: (...args: Parameters<typeof tessellator.tessellate.layer>) => {
      calls.layers++;
      return tessellator.tessellate.layer(...args);
    },
    lines: tessellator.tessellate.lines,
  };
  const parts = new Parts(geometries, tessellate, new LineCache(geometries, tessellate), kept);
  return { tessellator, geometries, parts, calls };
}

test("a part of fills that meet is marked flat once it has stood, one of fills over each other not", () => {
  const { tessellator, geometries, parts, calls } = counting();
  try {
    const flatness = (x: number, y = 0) => {
      const d = squares(x, y);
      const o = {} as DisplayObject;
      const [part] = parts.partsOf(d.layers[0], d.version);
      const before = geometries.get(part.handle.id)?.flat;
      // Not on the frame it was made.
      for (let frame = 0; frame < 1; frame++) {
        parts.markFlat(o, d.layers[0], part);
        assert.equal(geometries.get(part.handle.id)?.flat, before);
        geometries.endFrame();
        parts.partsOf(d.layers[0], d.version);
      }

      const made = calls.layers;
      parts.markFlat(o, d.layers[0], part);
      const flattened = geometries.flattened.length;
      // Looked into once: asked again, it is not tessellated again.
      parts.markFlat(o, d.layers[0], part);
      return [before, geometries.get(part.handle.id)?.flat, flattened, calls.layers - made];
    };

    assert.deepEqual(flatness(20), [false, true, 1, 1]);
    geometries.flattened.length = 0;
    // Over each other: their triangles cover more than the box around them, tessellating nothing.
    assert.deepEqual(flatness(10), [false, false, 0, 0]);
    // Over each other within their box: tessellated together once.
    assert.deepEqual(flatness(10, 10), [false, false, 0, 1]);
  } finally {
    tessellator.dispose();
  }
});

test("a drawing made again on every frame is never looked into", () => {
  const { tessellator, geometries, parts, calls } = counting();
  try {
    const d = squares(20);
    const o = {} as DisplayObject;
    for (let frame = 0; frame < 10; frame++) {
      d.clear();
      d.beginFill({ type: "solid", color: 0xff0088ff });
      d.drawRect(frame, 0, 20, 20);
      d.beginFill({ type: "solid", color: 0xffff8800 });
      d.drawRect(frame + 20, 0, 20, 20);
      d.endFill();
      const [part] = parts.partsOf(d.layers[0], d.version);
      const made = calls.layers;
      parts.markFlat(o, d.layers[0], part);
      assert.equal(calls.layers, made, `frame ${frame}`);
      geometries.endFrame();
    }
  } finally {
    tessellator.dispose();
  }
});

test("a drawing made again every second or third frame is looked into a few times, not each time", () => {
  for (const every of [2, 3]) {
    const { tessellator, geometries, parts, calls } = counting();
    try {
      const o = {} as DisplayObject;
      let d = squares(10, 10);
      let joint = 0;
      for (let frame = 0; frame < 30; frame++) {
        // Over each other within their box, which only tessellating them together finds.
        if (frame % every === 0) {
          d = squares(10 + frame / 10, 10);
        }

        const [part] = parts.partsOf(d.layers[0], d.version);
        const made = calls.layers;
        parts.markFlat(o, d.layers[0], part);
        joint += calls.layers - made;
        geometries.endFrame();
      }

      // Each look doubles what the next part must stand: 1, 2, 4, soon more than it stands.
      assert.equal(joint, every - 1, `every ${every}`);
    } finally {
      tessellator.dispose();
    }
  }
});

/**
 * A tween of `ratios` played `loops` times, each ratio drawn for `hold`
 * frames: the layers' parts asked for on each, as the view asks.
 */
function tween(
  { geometries, parts }: ReturnType<typeof counting>,
  morph: ReturnType<typeof crossingMorph>,
  ratios: number[],
  hold: number,
  loops: number,
): void {
  for (let loop = 0; loop < loops; loop++) {
    for (const ratio of ratios) {
      const { layers } = morphAt(morph, ratio);
      for (let frame = 0; frame < hold; frame++) {
        for (const layer of layers) {
          for (const part of parts.partsOf(layer, 0)) {
            assert.ok(geometries.alive(part.handle));
          }
        }

        geometries.endFrame();
      }
    }
  }
}

test("a tween longer than the idle frames tessellates its slow blends once, its fast ones each loop", () => {
  // Each ratio undrawn for longer than IDLE_FRAMES between its visits.
  const ratios = [0, 13107, 26214, 39321, 52428, 65535];
  const hold = Math.ceil(IDLE_FRAMES / (ratios.length - 1)) + 1;
  for (const [slowMs, expected] of [
    [0, ratios.length],
    [Number.POSITIVE_INFINITY, ratios.length * 3],
  ]) {
    const fixture = counting({ slowMs });
    try {
      tween(fixture, crossingMorph(4), ratios, hold, 3);
      assert.equal(fixture.calls.layers, expected, `slowMs ${slowMs}`);
      assert.equal(fixture.parts.keptSize > 0, slowMs === 0);
    } finally {
      fixture.tessellator.dispose();
    }
  }
});

test("a blend slower to tessellate than SLOW_PARTS_MS keeps its triangles, a context lost too", () => {
  // Some hundreds of milliseconds each, well past the threshold on any machine.
  const morph = crossingMorph(40);
  const fixture = counting();
  const { geometries, parts, calls, tessellator } = fixture;
  try {
    const started = performance.now();
    tween(fixture, morph, [0, 65535], IDLE_FRAMES + 2, 2);
    assert.ok((performance.now() - started) / 2 > SLOW_PARTS_MS);
    assert.equal(calls.layers, 2);
    assert.ok(parts.keptSize > 0);

    geometries.lost();
    tween(fixture, morph, [0, 65535], 1, 1);
    assert.equal(calls.layers, 2);
  } finally {
    tessellator.dispose();
  }
});

test("kept triangles stay within their bytes, the least recently drawn let go of first", () => {
  const morph = crossingMorph(3);
  const sizing = counting({ slowMs: 0 });
  let size: number;
  try {
    sizing.parts.partsOf(morphAt(morph, 0).layers[0], 0);
    size = sizing.parts.keptSize;
  } finally {
    sizing.tessellator.dispose();
  }

  // Room for two and a half blends of about that size.
  const bytes = Math.floor(size * 2.5);
  const fixture = counting({ slowMs: 0, bytes });
  const { geometries, parts, calls, tessellator } = fixture;
  try {
    const ratios = [0, 16384, 32768, 49152, 65535];
    const layers = ratios.map((ratio) => morphAt(morph, ratio).layers[0]);
    for (const layer of layers) {
      parts.partsOf(layer, 0);
      assert.ok(parts.keptSize <= bytes);
    }

    assert.ok(parts.keptSize > 0);
    for (let frame = 0; frame <= IDLE_FRAMES + 1; frame++) {
      geometries.endFrame();
    }

    // The last two are added again, the first three tessellated again.
    const made = calls.layers;
    for (const layer of layers.slice(3)) {
      parts.partsOf(layer, 0);
    }

    assert.equal(calls.layers, made);
    for (const layer of layers.slice(0, 3)) {
      parts.partsOf(layer, 0);
      assert.ok(parts.keptSize <= bytes);
    }

    assert.equal(calls.layers, made + 3);

    // One larger than the bound is never kept.
    const small = counting({ slowMs: 0, bytes: Math.floor(size / 2) });
    try {
      small.parts.partsOf(layers[0], 0);
      assert.equal(small.parts.keptSize, 0);
    } finally {
      small.tessellator.dispose();
    }
  } finally {
    tessellator.dispose();
  }
});

test("a drawing's next version, or a layer it no longer draws, lets its kept triangles go", () => {
  const { tessellator, parts } = counting({ slowMs: 0 });
  try {
    const d = squares(40);
    const o = {} as DisplayObject;
    parts.dropUndrawn(o, d.layers, d.version);
    parts.partsOf(d.layers[0], d.version);
    const first = parts.keptSize;
    assert.ok(first > 0);
    // Changed in place: the old version's let go of, the new one's kept in their stead.
    parts.partsOf(d.layers[0], d.version + 1);
    assert.equal(parts.keptSize, first);

    const e = squares(60);
    parts.dropUndrawn(o, e.layers, d.version + 1);
    assert.equal(parts.keptSize, 0);
  } finally {
    tessellator.dispose();
  }
});

test("a collected layer's kept triangles go with it", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const { tessellator, parts } = counting({ slowMs: 0 });
  try {
    const keep = (): WeakRef<ShapeLayer> => {
      const layer = squares(40).layers[0];
      parts.partsOf(layer, 0);
      return new WeakRef(layer);
    };
    const layer = keep();
    assert.ok(parts.keptSize > 0);

    for (let i = 0; i < 20 && parts.keptSize > 0; i++) {
      await setImmediate();
      gc();
    }

    assert.equal(layer.deref(), undefined);
    assert.equal(parts.keptSize, 0);
  } finally {
    tessellator.dispose();
  }
});
