import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Tessellator } from "@swf2es/native/render";
import { Drawing } from "../../../../packages/player/dist/display/drawing.js";
import { LineCache } from "../../../../packages/player/dist/scene/lines.js";
import { Parts } from "../../../../packages/player/dist/scene/parts.js";
import { Geometries, IDLE_FRAMES } from "../../../../packages/render/dist/index.js";

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
function counting() {
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
  const parts = new Parts(geometries, tessellate, new LineCache(geometries, tessellate));
  return { tessellator, geometries, parts, calls };
}

test("a part of fills that meet is marked flat once it has stood, one of fills over each other not", () => {
  const { tessellator, geometries, parts, calls } = counting();
  try {
    const flatness = (x: number, y = 0) => {
      const d = squares(x, y);
      const [part] = parts.partsOf(d.layers[0], d.version);
      const before = geometries.get(part.handle.id)?.flat;
      // Not on the frame it was made.
      for (let frame = 0; frame < 1; frame++) {
        parts.markFlat(d.layers[0], part);
        assert.equal(geometries.get(part.handle.id)?.flat, before);
        geometries.endFrame();
        parts.partsOf(d.layers[0], d.version);
      }

      const made = calls.layers;
      parts.markFlat(d.layers[0], part);
      const flattened = geometries.flattened.length;
      // Looked into once: asked again, it is not tessellated again.
      parts.markFlat(d.layers[0], part);
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
    for (let frame = 0; frame < 10; frame++) {
      d.clear();
      d.beginFill({ type: "solid", color: 0xff0088ff });
      d.drawRect(frame, 0, 20, 20);
      d.beginFill({ type: "solid", color: 0xffff8800 });
      d.drawRect(frame + 20, 0, 20, 20);
      d.endFill();
      const [part] = parts.partsOf(d.layers[0], d.version);
      const made = calls.layers;
      parts.markFlat(d.layers[0], part);
      assert.equal(calls.layers, made, `frame ${frame}`);
      geometries.endFrame();
    }
  } finally {
    tessellator.dispose();
  }
});
