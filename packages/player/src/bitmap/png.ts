// BitmapData.encode's PNG: a file of IHDR, one IDAT and IEND, as Flash
// writes, RGBA for a transparent bitmap and RGB for an opaque one. The
// colours are divided out of alpha as Flash's encoder does it,
// floor(c * 256 / a) up to 255 (every alpha and value checked under adl),
// which is not getPixel32's rounding. The bytes need not be Flash's, only
// what they decode to: fast compression filters no row and deflates at
// level 1, as Flash does; otherwise each row takes the filter whose output
// sums smallest, libpng's heuristic, deflated at level 6 where Flash uses
// 9: a 1080p frame takes a quarter of the time for 1% more bytes. The
// rows are made, filtered and deflated by @swf2es/native, in one pass.
import { pngEncode } from "@swf2es/native/compress";
import type { BitmapStore, PixelRect } from "./bitmap.js";

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }

  CRC[n] = c >>> 0;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}

/** `rect` of the store, clipped to it and not empty, as a PNG file. */
export function encodePng(store: BitmapStore, rect: PixelRect, fast: boolean): Uint8Array {
  const { x: x0, y: y0, width, height } = rect;
  const channels = store.transparent ? 4 : 3;
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

  const data = pngEncode(rows, width, height, channels, fast ? 1 : 6, !fast);
  const out = new Uint8Array(8 + 25 + 12 + data.length + 12);
  const view = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  const chunk = (type: string, length: number, write: (at: number) => void) => {
    view.setUint32(at, length);
    for (let k = 0; k < 4; k++) {
      out[at + 4 + k] = type.charCodeAt(k);
    }

    write(at + 8);
    view.setUint32(at + 8 + length, crc32(out, at + 4, at + 8 + length));
    at += 12 + length;
  };
  chunk("IHDR", 13, (p) => {
    view.setUint32(p, width);
    view.setUint32(p + 4, height);
    // 8 bits a channel, RGBA (6) or RGB (2), deflate, adaptive filtering, no interlace.
    out.set([8, channels === 4 ? 6 : 2, 0, 0, 0], p + 8);
  });
  chunk("IDAT", data.length, (p) => out.set(data, p));
  chunk("IEND", 0, () => {});
  return out;
}
