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
import {
  KeptParts,
  type KeptPartsOptions,
  SLOW_PARTS_MS,
} from "../../../../packages/player/dist/scene/kept-parts.js";
import { LineCache } from "../../../../packages/player/dist/scene/lines.js";
import { Parts } from "../../../../packages/player/dist/scene/parts.js";
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
  // Nothing kept, however long a busy machine takes.
  const parts = new Parts(
    geometries,
    tessellator.tessellate,
    new LineCache(geometries, tessellator.tessellate),
    new KeptParts({ slowMs: Number.POSITIVE_INFINITY }),
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

/** `fixture`'s, with the tessellator's layer calls counted, keeping triangles in a store of its own. */
function counting(options: KeptPartsOptions = { slowMs: Number.POSITIVE_INFINITY }) {
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
  const kept = new KeptParts(options);
  const parts = new Parts(geometries, tessellate, new LineCache(geometries, tessellate), kept);
  return { tessellator, geometries, parts, calls, kept };
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

/** Frames enough for what was drawn before them to expire, each ended as the view ends one. */
function idle({ geometries, parts }: ReturnType<typeof counting>): void {
  for (let frame = 0; frame <= IDLE_FRAMES + 1; frame++) {
    geometries.endFrame();
    parts.endFrame();
  }
}

/**
 * A tween of `ratios` played `loops` times, each ratio drawn for `hold`
 * frames and nothing for `gap` frames after each loop: the layers' parts
 * asked for on each, as the view asks, and the tessellations each loop made.
 */
function tween(
  fixture: ReturnType<typeof counting>,
  morph: ReturnType<typeof crossingMorph>,
  ratios: number[],
  hold: number,
  loops: number,
  gap = 0,
): number[] {
  const { geometries, parts, calls, kept } = fixture;
  const made: number[] = [];
  for (let loop = 0; loop < loops; loop++) {
    const before = calls.layers;
    for (const ratio of ratios) {
      const { layers } = morphAt(morph, ratio);
      for (let frame = 0; frame < hold; frame++) {
        for (const layer of layers) {
          for (const part of parts.partsOf(layer, 0)) {
            assert.ok(geometries.alive(part.handle));
          }
        }

        geometries.endFrame();
        parts.endFrame();
        assert.ok(kept.bytes <= kept.most);
      }
    }

    for (let frame = 0; frame < gap; frame++) {
      geometries.endFrame();
      parts.endFrame();
    }

    made.push(calls.layers - before);
  }

  return made;
}

/** Each ratio undrawn for longer than IDLE_FRAMES between its visits. */
function holdFor(ratios: number[]): number {
  return Math.ceil(IDLE_FRAMES / (ratios.length - 1)) + 1;
}

const SIX = [0, 13107, 26214, 39321, 52428, 65535];

test("a tween longer than the idle frames tessellates its slow blends once, its fast ones each loop", () => {
  for (const [slowMs, expected] of [
    [0, [6, 0, 0]],
    [Number.POSITIVE_INFINITY, [6, 6, 6]],
  ] as const) {
    const fixture = counting({ slowMs });
    try {
      assert.deepEqual(tween(fixture, crossingMorph(4), SIX, holdFor(SIX), 3), expected);
      assert.equal(fixture.kept.size, slowMs === 0 ? 6 : 0);
    } finally {
      fixture.tessellator.dispose();
    }
  }
});

test("a blend slower to tessellate than SLOW_PARTS_MS keeps its triangles", () => {
  // Some hundreds of milliseconds each, well past the threshold on any machine.
  const morph = crossingMorph(40);
  const fixture = counting({});
  try {
    const started = performance.now();
    assert.deepEqual(tween(fixture, morph, [0, 65535], IDLE_FRAMES + 2, 2), [2, 0]);
    assert.ok((performance.now() - started) / 2 > SLOW_PARTS_MS);
    assert.equal(fixture.kept.size, 2);
  } finally {
    fixture.tessellator.dispose();
  }
});

test("re-added triangles are the ones made, flat and looked into as they were", () => {
  const fixture = counting({ slowMs: 0 });
  const { geometries, parts, calls, tessellator } = fixture;
  try {
    // Two fills that meet: flat once looked into.
    const d = squares(20);
    const layer = d.layers[0];
    const o = {} as DisplayObject;
    const [part] = parts.partsOf(layer, d.version);
    const made = geometries.get(part.handle.id);
    assert.ok(made);
    const positions = made.positions.slice();
    const indices = made.indices.slice();
    geometries.endFrame();
    parts.markFlat(o, layer, part);
    assert.equal(made.flat, true);
    assert.equal(part.fillsTo, part.fillsFrom);

    idle(fixture);
    assert.ok(!geometries.alive(part.handle));
    assert.ok(fixture.kept.bytes > 0);
    const looked = calls.layers;
    const [again] = parts.partsOf(layer, d.version);
    assert.notEqual(again.handle, part.handle);
    assert.equal(again.madeAt, geometries.frame);
    assert.equal(fixture.kept.bytes, 0, "added again, they count no more");
    const data = geometries.get(again.handle.id);
    assert.ok(data);
    assert.deepEqual(data.positions, positions);
    assert.deepEqual(data.indices, indices);
    assert.equal(data.flat, true);
    assert.equal(again.fillsTo, again.fillsFrom);

    // Not looked into again, standing or not.
    geometries.endFrame();
    parts.markFlat(o, layer, again);
    assert.equal(calls.layers, looked);
  } finally {
    tessellator.dispose();
  }
});

test("a layer kept as drawn and as a mask is added again as both", () => {
  const fixture = counting({ slowMs: 0 });
  const { parts, calls, tessellator } = fixture;
  try {
    const layer = squares(40).layers[0];
    parts.partsOf(layer, 0);
    parts.partsOf(layer, 0, true);
    assert.equal(calls.layers, 2);
    assert.equal(fixture.kept.size, 2);

    idle(fixture);
    const both = fixture.kept.bytes;
    assert.ok(both > 0);
    parts.partsOf(layer, 0);
    assert.ok(fixture.kept.bytes > 0 && fixture.kept.bytes < both);
    parts.partsOf(layer, 0, true);
    assert.equal(fixture.kept.bytes, 0);
    assert.equal(calls.layers, 2);
  } finally {
    tessellator.dispose();
  }
});

test("a layer with a fill refused keeps nothing, to be tried again", () => {
  const tessellator = new Tessellator();
  const geometries = new Geometries();
  const kept = new KeptParts({ slowMs: 0 });
  let calls = 0;
  const tessellate = {
    layer: (...args: Parameters<typeof tessellator.tessellate.layer>) => {
      calls++;
      const out = tessellator.tessellate.layer(...args);
      return out && [null, ...out.slice(1)];
    },
    lines: tessellator.tessellate.lines,
  };
  const parts = new Parts(geometries, tessellate, new LineCache(geometries, tessellate), kept);
  try {
    const layer = squares(40).layers[0];
    parts.partsOf(layer, 0);
    assert.equal(kept.size, 0);
    for (let frame = 0; frame <= IDLE_FRAMES + 1; frame++) {
      geometries.endFrame();
      parts.endFrame();
    }

    parts.partsOf(layer, 0);
    assert.equal(calls, 2);
  } finally {
    tessellator.dispose();
  }
});

/** The bytes a blend of `crossingMorph(count)` keeps. */
function blendBytes(count: number): number {
  const fixture = counting({ slowMs: 0 });
  try {
    fixture.parts.partsOf(morphAt(crossingMorph(count), 32768).layers[0], 0);
    idle(fixture);
    return fixture.kept.bytes;
  } finally {
    fixture.tessellator.dispose();
  }
}

test("a tween of more slow blends than fit keeps finding the same share of them each loop", () => {
  const ratios = [0, 8192, 16384, 24576, 32768, 40960, 49152, 57344, 65535];
  // Every blend made in a millisecond, and room for about three of the nine.
  let clock = 0;
  const bytes = Math.floor(blendBytes(4) * 3.5);
  const fixture = counting({ slowMs: 0, bytes, now: () => clock++ });
  try {
    // Shown for a moment, then hidden for longer than the idle frames: every blend expired at once.
    const made = tween(fixture, crossingMorph(4), ratios, 2, 6, 2 * IDLE_FRAMES);
    assert.equal(made[0], ratios.length);
    const hits = made.slice(1).map((m) => ratios.length - m);
    assert.deepEqual(hits, [3, 3, 3, 3, 3]);
  } finally {
    fixture.tessellator.dispose();
  }
});

test("expired triangles stay within their bytes: those worth more a byte push out those worth less", () => {
  const size = blendBytes(4);
  // Room for two, and the clock's readings around each making.
  let readings: number[] = [];
  const fixture = counting({
    slowMs: 0,
    bytes: Math.floor(size * 2.5),
    now: () => readings.shift() ?? 0,
  });
  const { parts, calls, kept, tessellator } = fixture;
  try {
    const morph = crossingMorph(4);
    const layers = [0, 20000, 40000, 60000].map((ratio) => morphAt(morph, ratio).layers[0]);
    // Made in 1, 3, 2 and 1 milliseconds.
    for (const [i, layer] of layers.entries()) {
      readings = [0, [1, 3, 2, 1][i]];
      parts.partsOf(layer, 0);
    }

    assert.equal(kept.size, 4);
    idle(fixture);
    // The first and the last, worth least, are let go of; a tie with what it would push out too.
    assert.equal(kept.size, 2);
    assert.ok(kept.bytes <= Math.floor(size * 2.5));
    const made = calls.layers;
    parts.partsOf(layers[1], 0);
    parts.partsOf(layers[2], 0);
    assert.equal(calls.layers, made);
    parts.partsOf(layers[0], 0);
    parts.partsOf(layers[3], 0);
    assert.equal(calls.layers, made + 2);

    // One larger than the budget is never kept.
    const small = counting({ slowMs: 0, bytes: Math.floor(size / 2) });
    try {
      small.parts.partsOf(layers[0], 0);
      assert.equal(small.kept.size, 0);
    } finally {
      small.tessellator.dispose();
    }
  } finally {
    tessellator.dispose();
  }
});

test("expired triangles not added again for long may be let go of whatever they cost", () => {
  const size = blendBytes(4);
  // The first made in 100 ms, the second in 1 ms.
  const readings = [0, 100, 0, 1];
  const fixture = counting({
    slowMs: 0,
    bytes: Math.floor(size * 1.5),
    now: () => readings.shift() ?? 0,
  });
  const { geometries, parts, calls, kept, tessellator } = fixture;
  try {
    const morph = crossingMorph(4);
    const [first, second] = [0, 65535].map((ratio) => morphAt(morph, ratio).layers[0]);
    parts.partsOf(first, 0);
    idle(fixture);
    assert.equal(kept.bytes > 0, true);
    for (let frame = 0; frame < 10 * IDLE_FRAMES; frame++) {
      geometries.endFrame();
      parts.endFrame();
    }

    parts.partsOf(second, 0);
    idle(fixture);
    // The first, gone stale, gives way to the second, worth far less.
    assert.equal(kept.size, 1);
    const made = calls.layers;
    parts.partsOf(second, 0);
    assert.equal(calls.layers, made);
    parts.partsOf(first, 0);
    assert.equal(calls.layers, made + 1);
  } finally {
    tessellator.dispose();
  }
});

test("a drawing's next version, or a layer it no longer draws, lets its kept triangles go", () => {
  const { tessellator, parts, kept } = counting({ slowMs: 0 });
  try {
    const d = squares(40);
    const o = {} as DisplayObject;
    parts.dropUndrawn(o, d.layers, d.version);
    parts.partsOf(d.layers[0], d.version);
    assert.equal(kept.size, 1);
    // Changed in place: the old version's let go of, the new one's kept in their stead.
    parts.partsOf(d.layers[0], d.version + 1);
    assert.equal(kept.size, 1);

    const e = squares(60);
    parts.dropUndrawn(o, e.layers, d.version + 1);
    assert.equal(kept.size, 0);
  } finally {
    tessellator.dispose();
  }
});

test("a collected layer's kept triangles go with it", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const { tessellator, parts, kept } = counting({ slowMs: 0 });
  try {
    const keep = (): WeakRef<ShapeLayer> => {
      const layer = squares(40).layers[0];
      parts.partsOf(layer, 0);
      return new WeakRef(layer);
    };
    const layer = keep();
    assert.equal(kept.size, 1);

    for (let i = 0; i < 20 && kept.size > 0; i++) {
      await setImmediate();
      gc();
    }

    assert.equal(layer.deref(), undefined);
    assert.equal(kept.size, 0);
  } finally {
    tessellator.dispose();
  }
});
