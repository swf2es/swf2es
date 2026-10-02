// The renderer's GPU copies of bitmaps, with renderers that stand in for
// WebGL's: each keeps its own copy of a store, and one shows what another
// drew by reading it back through the renderer that drew it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../packages/player/dist/bitmap.js";
import { BitmapObject, Container } from "../../../packages/player/dist/display.js";
import { PixiView } from "../../../packages/player/dist/pixi.js";

/** A renderer that draws nothing and reads back `pixels`, counting its reads. */
function standIn(pixels: number[]) {
  const reads: unknown[] = [];
  const renderer = {
    render: () => {},
    extract: {
      pixels: (target: unknown) => {
        reads.push(target);
        return { pixels: Uint8ClampedArray.from(pixels) };
      },
    },
  };
  return { renderer: renderer as unknown as ConstructorParameters<typeof PixiView>[0], reads };
}

test("a store shown by two renderers has a copy in each, and what one drew reaches the other", () => {
  // Two pixels, premultiplied RGBA as a texture holds them.
  const drawn = [0x10, 0x20, 0x30, 0xff, 0x40, 0x20, 0x10, 0x80];
  const a = standIn(drawn);
  const b = standIn([]);
  const first = new PixiView(a.renderer);
  const second = new PixiView(b.renderer);
  const store = new BitmapStore(2, 1, true, 0);

  // The first renderer draws into the store; nothing comes back yet.
  assert.equal(
    first.drawInto(store, new Container(), { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, 0, 0, 2, 1, 1),
    true,
  );
  assert.equal(store.newerOnGpu, true);
  assert.equal(store.copies.size, 1);
  assert.equal(a.reads.length, 0);

  // The second shows it: read back through the first, uploaded to a copy of its own.
  second.render(new BitmapObject(store));
  assert.equal(store.copies.size, 2);
  assert.equal(a.reads.length, 1);
  assert.equal(b.reads.length, 0);
  assert.deepEqual(
    [...store.pixels].map((p) => p.toString(16)),
    ["ff102030", "80402010"],
  );
  const theirs = [...store.copies].find((copy) => copy !== store.gpu) as unknown as {
    source: { resource: Uint8Array };
  };
  assert.deepEqual([...theirs.source.resource], drawn);

  // Read once: the first renderer is not asked again.
  second.render(new BitmapObject(store));
  assert.equal(a.reads.length, 1);

  store.dispose();
  assert.equal(store.copies.size, 0);
});

test("a timeline mask's range goes in a container it masks, a scroll clips the rest, and a mask off the list sits beside the root", () => {
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const [mask, , , c] = [1, 2, 3, 4].map((depth) => {
    const child = new Container();
    root.placeAtDepth(child, depth);
    return child;
  });
  mask.clipDepth = 3;
  view.prepare(root);

  const top = view.stage.children[0];
  const [art, maskContainer, group, cContainer] = top.children;
  assert.equal(top.children.length, 4);
  assert.equal(art.children.length, 0);
  assert.equal(group.mask, maskContainer);
  assert.equal(group.children.length, 2);
  assert.ok(!cContainer.mask);
  assert.equal(maskContainer.includeInBuild, false);

  // Scrolled: its art and children go in a container the scroll's rectangle masks.
  root.scroll = { xMin: 5, yMin: 5, xMax: 25, yMax: 15 };
  root.invalidate(1);
  view.prepare(root);
  const [clip, content] = top.children;
  assert.equal(top.children.length, 2);
  assert.equal(content.mask, clip);
  assert.equal(content.children.length, 4);
  assert.deepEqual([top.x, top.y], [-5, -5]);

  // A mask off the list clips from beside the root, at its own place.
  const off = new Container();
  off.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 30, ty: 40 });
  c.setMask(off);
  view.prepare(root);
  const holder = view.stage.children[1];
  assert.equal(holder.children.length, 1);
  assert.equal(holder.children[0].x, 30);
  const cNode = content.children[3];
  assert.equal(cNode.mask, holder.children[0]);

  // And none once the mask is taken off.
  c.setMask(null);
  view.prepare(root);
  assert.equal(holder.children.length, 0);
  assert.ok(!cNode.mask);
});
