import assert from "node:assert/strict";
import { test } from "node:test";
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
    const other = geometries.add(first[0].part.geometry);
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
    geometries.remove(old.id);
    const replacement = geometries.add(first[0].part.geometry);
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
