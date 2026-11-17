import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { drawVideo } from "../../../../packages/player/dist/bitmap/draw.js";
import { Container } from "../../../../packages/player/dist/display/container.js";
import { CLEAN } from "../../../../packages/player/dist/display/displayobject.js";
import { VideoObject } from "../../../../packages/player/dist/display/videoobject.js";
import { type VideoPicture, VideoSource } from "../../../../packages/player/dist/media/video.js";
import { Videos } from "../../../../packages/player/dist/scene/videos.js";
import { Textures } from "../../../../packages/render/dist/index.js";

function picture(width = 2, height = 1) {
  let reads = 0;
  const frame: VideoPicture = {
    width,
    height,
    image: {} as VideoPicture["image"],
    readPixels: () => {
      reads++;
      return new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]);
    },
  };
  return { frame, reads: () => reads };
}

test("video frames invalidate ancestors, share uploads, and read pixels only on demand", () => {
  const source = new VideoSource();
  const a = new VideoObject();
  const b = new VideoObject();
  const parent = new Container();
  parent.addChildAt(a, 0);
  a.source = source;
  b.source = source;
  a.dirty = b.dirty = CLEAN;
  parent.descendantsDirty = false;
  const first = picture();
  source.publish(first.frame);
  assert.notEqual(a.dirty, CLEAN);
  assert.notEqual(b.dirty, CLEAN);
  assert.equal(parent.descendantsDirty, true);
  assert.equal(first.reads(), 0);

  const textures = new Textures();
  const videos = new Videos(textures);
  const handle = videos.texture(source);
  assert.ok(handle);
  assert.equal(videos.texture(source), handle);
  assert.equal(textures.pending.length, 1);
  textures.pending.length = 0;
  assert.equal(videos.texture(source), handle);
  assert.equal(textures.pending.length, 0);
  assert.equal(first.reads(), 0);

  const cpu = source.bitmap();
  assert.ok(cpu);
  assert.deepEqual([...cpu.pixels], [0xffff0000, 0x80008000]);
  assert.equal(source.bitmap(), cpu);
  assert.equal(first.reads(), 1);

  a.clear();
  assert.equal(a.picture, null);
  assert.equal(b.picture, first.frame);
  source.publish(first.frame);
  assert.equal(a.picture, first.frame);
  videos.texture(source);
  assert.equal(textures.pending.length, 1);
  assert.notEqual(source.bitmap(), cpu);
  assert.equal(first.reads(), 2);

  textures.lost();
  const restored = videos.texture(source);
  assert.ok(restored);
  assert.notDeepEqual(restored, handle);
  assert.equal(textures.get(restored.id)?.source, first.frame.image);

  a.source = null;
  a.dirty = CLEAN;
  source.publish(null);
  assert.equal(a.dirty, CLEAN);
  assert.equal(b.picture, null);
  assert.equal(source.bitmap(), null);
  assert.equal(videos.texture(source), null);
});

test("CPU video draw scales the frame into its box, respects clip and ignores its placement", () => {
  const source = new VideoSource();
  source.publish(picture().frame);
  const video = new VideoObject();
  video.source = source;
  video.boxWidth = 4;
  video.boxHeight = 2;
  video.matrix.tx = 100;
  const target = new BitmapStore(6, 4, true, 0);
  drawVideo(
    target,
    video,
    { a: 1, b: 0, c: 0, d: 1, tx: 1, ty: 1 },
    null,
    "normal",
    { x: 1, y: 1, width: 3, height: 2 },
    false,
  );
  assert.equal(target.pixels[7], 0xffff0000);
  assert.equal(target.pixels[8], 0xffff0000);
  assert.equal(target.pixels[9], 0x80008000);
  assert.equal(target.pixels[10], 0);
  assert.equal(target.pixels[13], 0xffff0000);
  video.clear();
  const empty = new BitmapStore(4, 2, true, 0);
  drawVideo(empty, video, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, null, "normal", null, false);
  assert.ok(empty.pixels.every((pixel) => pixel === 0));
});

test("CPU video copies apply the supplied colour transform, blend and reflected matrix", () => {
  const source = new VideoSource();
  source.publish(picture().frame);
  const video = new VideoObject();
  video.source = source;
  video.boxWidth = 2;
  video.boxHeight = 1;
  const matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  const multiply = new BitmapStore(2, 1, false, 0xff0000ff);
  drawVideo(multiply, video, matrix, null, "multiply", null, false);
  assert.deepEqual([...multiply.pixels], [0xff010101, 0xff010180]);

  const colored = new BitmapStore(2, 1, true, 0);
  drawVideo(
    colored,
    video,
    matrix,
    { rMul: 0, gMul: 0, bMul: 0, aMul: 1, rAdd: 0, gAdd: 255, bAdd: 0, aAdd: 0 },
    "normal",
    null,
    false,
  );
  assert.deepEqual([...colored.pixels], [0xff00ff00, 0x80008000]);

  const reflected = new BitmapStore(2, 1, true, 0);
  drawVideo(reflected, video, { ...matrix, a: -1, tx: 2 }, null, "normal", null, false);
  assert.deepEqual([...reflected.pixels], [0x80008000, 0xffff0000]);
});
