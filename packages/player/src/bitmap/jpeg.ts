// BitmapData.encode's JPEG, as Flash writes one, which is as libjpeg does
// by default (every choice measured under adl; see jpeg.zig in
// @swf2es/native, which encodes it): JFIF, 4:2:0, Annex K's tables scaled
// to the quality, its Huffman tables. Alpha is left out, as Flash leaves
// it: a transparent bitmap's premultiplied colours are encoded as they
// are kept, so what is clear comes out black. The bytes are Flash's where
// the picture is flat or the quality low; elsewhere a coefficient next to
// a rounding boundary may differ by one.
import { jpegEncode } from "@swf2es/native/compress";
import type { BitmapStore, PixelRect } from "./bitmap.js";

/** `rect` of the store, clipped to it and not empty, as a JPEG file at `quality`, 0 to 100. */
export function encodeJpeg(store: BitmapStore, rect: PixelRect, quality: number): Uint8Array {
  const { x: x0, y: y0, width, height } = rect;
  const pixels = store.drawable;
  // The rows the module reads: the store's own where the area is as wide as it, else gathered.
  let rows: Uint32Array;
  if (x0 === 0 && width === store.width) {
    rows = pixels.subarray(y0 * width, (y0 + height) * width);
  } else {
    rows = new Uint32Array(width * height);
    for (let y = 0; y < height; y++) {
      const from = (y0 + y) * store.width + x0;
      rows.set(pixels.subarray(from, from + width), y * width);
    }
  }

  return jpegEncode(rows, width, height, quality);
}
