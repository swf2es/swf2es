import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, ShapeObject } from "../../packages/player/dist/display/display.js";
import { FrameAssets, FrameMirror, FrameWriter, frameSlot } from "./playback-scene.ts";

function shape(id = 1): ShapeObject {
  return new ShapeObject({
    type: "shape",
    id,
    shape: { bounds: { xMin: 0, yMin: 0, xMax: 20, yMax: 20 }, edgeBounds: null },
    layers: [],
  });
}

test("frame ownership, rejected capture recovery and retained ordering", () => {
  const source = new Container(),
    left = new Container(),
    right = new Container(),
    a = shape(),
    b = shape(2);
  source.addChildAt(left, 0);
  source.addChildAt(right, 1);
  left.addChildAt(a, 0);
  left.addChildAt(b, 1);
  const slot = frameSlot(),
    writer = new FrameWriter(),
    assets = new FrameAssets(),
    mirror = new FrameMirror(assets);
  const read = () => {
    const packet = structuredClone(writer.capture(source, slot));
    assets.add(packet);
    return mirror.apply(packet, slot) as Container;
  };
  const first = read();
  const firstLeft = first.children[0] as Container,
    firstRight = first.children[1] as Container;
  const firstA = firstLeft.children[0],
    firstB = firstLeft.children[1];
  right.addChildAt(a, 0);
  left.addChildAt(b, 0);
  assert.equal(read(), first);
  assert.deepEqual(firstLeft.children, [firstB]);
  assert.deepEqual(firstRight.children, [firstA]);
  assert.equal(firstA.parent, firstRight);
  a.matrix.tx = 19;
  read();
  assert.equal(firstA.matrix.tx, 19);
  const packet = writer.capture(source, slot);
  assert.throws(() => writer.capture(source, slot), /still owned/);
  mirror.apply(packet, slot);
  const valid = shape(3);
  source.addChildAt(valid, 2);
  const unsupported = shape(4);
  unsupported.mask = new Container();
  source.addChildAt(unsupported, 3);
  assert.throws(() => writer.capture(source, slot), /unsupported display content/);
  source.removeChild(unsupported);
  assert.equal(read(), first);
  const bad = writer.capture(source, slot);
  new Float64Array(slot.values)[23] = -1;
  assert.throws(() => mirror.apply(bad, slot), /invalid playback frame node/);
  assert.deepEqual(firstRight.children, [firstA]);
  assert.equal(read(), first);
});
