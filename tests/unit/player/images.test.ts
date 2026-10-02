// A decoded image made into a bitmap's pixels as Flash makes them, with a
// decoder standing in for the browser's.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bitmap } from "../../../packages/format/dist/index.js";
import { type DecodedImage, decodeImages } from "../../../packages/player/dist/images.js";
import type { BitmapCharacter, Library } from "../../../packages/player/dist/timeline.js";

function library(definitions: Bitmap[]): { library: Library; characters: BitmapCharacter[] } {
  const characters = definitions.map(
    (definition): BitmapCharacter => ({
      type: "bitmap",
      id: definition.id,
      definition,
      pixels: null,
    }),
  );
  return {
    library: { characters: new Map(characters.map((c) => [c.id, c])) } as unknown as Library,
    characters,
  };
}

const image = (
  id: number,
  format: "jpeg" | "png" | "gif",
  alpha: number[] | null = null,
  opaque = false,
): Bitmap => ({
  id,
  type: "image",
  format,
  data: Uint8Array.of(id),
  alpha: alpha && Uint8Array.from(alpha),
  opaque,
});

// Two pixels of straight RGBA: (240, 128, 10) at alpha 1, and (60, 0, 200) at alpha 128.
const decoded: DecodedImage = {
  width: 2,
  height: 1,
  rgba: Uint8Array.of(240, 128, 10, 1, 60, 0, 200, 128),
};

const hex = (c: BitmapCharacter) => c.pixels && [...c.pixels.pixels].map((p) => p.toString(16));

test("decoded images become Flash's pixels", async () => {
  const { library: l, characters } = library([
    image(1, "png"),
    image(2, "jpeg", [128, 64]),
    image(3, "jpeg"),
    image(4, "jpeg", null, true),
    image(5, "jpeg", [1]),
  ]);
  await decodeImages(l, async () => decoded);
  const [png, jpeg3, jpeg, jpeg4, short] = characters;

  // A PNG's own alpha, premultiplied with the products floored: 240 at alpha 1 is 0.
  assert.deepEqual(hex(png), ["1000000", "801e0064"]);
  assert.equal(png.pixels?.transparent, true);
  // JPEG3's alpha beside the colours, each clamped to it, not premultiplied again.
  assert.deepEqual(hex(jpeg3), ["8080800a", "403c0040"]);
  // A JPEG alone is opaque; JPEG4 shows opaque though it reports transparent; alpha of the wrong size is none.
  assert.deepEqual([jpeg.pixels?.transparent, hex(jpeg)], [false, ["fff0800a", "ff3c00c8"]]);
  assert.deepEqual([jpeg4.pixels?.transparent, hex(jpeg4)], [true, ["fff0800a", "ff3c00c8"]]);
  assert.deepEqual([short.pixels?.transparent, hex(short)], [false, ["fff0800a", "ff3c00c8"]]);
});

test("an image no decoder can read is a bitmap of 0 by 0", async () => {
  const { library: l, characters } = library([image(1, "png"), image(2, "jpeg")]);
  await decodeImages(l, async (data) =>
    data[0] === 1 ? null : { width: 0, height: 0, rgba: new Uint8Array(0) },
  );
  for (const c of characters) {
    assert.deepEqual([c.pixels?.width, c.pixels?.height, c.pixels?.transparent], [0, 0, false]);
  }

  const none = library([image(3, "gif")]);
  await decodeImages(none.library, null);
  assert.equal(none.characters[0].pixels?.width, 0);
});
