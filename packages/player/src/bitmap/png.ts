// BitmapData.encode's PNG: a file of IHDR, one IDAT and IEND, as Flash
// writes, RGBA for a transparent bitmap and RGB for an opaque one. The
// colours are divided out of alpha as Flash's encoder does it,
// floor(c * 256 / a) up to 255 (every alpha and value checked under adl),
// which is not getPixel32's rounding. The bytes need not be Flash's, only
// what they decode to: fast compression filters no row and deflates at
// level 1, as Flash does; otherwise each row takes the filter whose output
// sums smallest, libpng's heuristic, deflated at level 6 where Flash uses
// 9: a 1080p frame takes a quarter of the time for 1% more bytes.
import { zlibCompress } from "@swf2es/format";
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
  const stride = 1 + width * channels;
  const raw = new Uint8Array(stride * height);
  const pixels = store.pixels;
  for (let y = 0; y < height; y++) {
    let j = y * stride + 1;
    for (let i = (y0 + y) * store.width + x0, end = i + width; i < end; i++) {
      const p = pixels[i];
      const a = p >>> 24;
      let r = (p >>> 16) & 0xff;
      let g = (p >>> 8) & 0xff;
      let b = p & 0xff;
      if (a === 0) {
        r = g = b = 0;
      } else if (a !== 255) {
        r = Math.min(255, ((r << 8) / a) | 0);
        g = Math.min(255, ((g << 8) / a) | 0);
        b = Math.min(255, ((b << 8) / a) | 0);
      }

      raw[j++] = r;
      raw[j++] = g;
      raw[j++] = b;
      if (channels === 4) {
        raw[j++] = a;
      }
    }
  }

  if (!fast) {
    filterRows(raw, stride, height, channels);
  }

  const data = zlibCompress(raw, fast ? 1 : 6);
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

/**
 * Each row, its filter byte 0 as written, given the filter of the five
 * whose output's bytes, taken as signed, sum smallest; rows are filtered
 * bottom up, so each still sees the unfiltered row above it.
 */
function filterRows(raw: Uint8Array, stride: number, height: number, bpp: number): void {
  const length = stride - 1;
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(length));
  for (let y = height - 1; y >= 0; y--) {
    const row = y * stride + 1;
    const up = y > 0 ? row - stride : -1;
    let best = 0;
    let bestSum = Number.POSITIVE_INFINITY;
    for (let f = 0; f < 5; f++) {
      const out = candidates[f];
      let sum = 0;
      for (let i = 0; i < length; i++) {
        const x = raw[row + i];
        const a = i >= bpp ? raw[row + i - bpp] : 0;
        const b = up >= 0 ? raw[up + i] : 0;
        const c = up >= 0 && i >= bpp ? raw[up + i - bpp] : 0;
        let v: number;
        switch (f) {
          case 0:
            v = x;
            break;
          case 1:
            v = x - a;
            break;
          case 2:
            v = x - b;
            break;
          case 3:
            v = x - ((a + b) >> 1);
            break;
          default: {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            v = x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          }
        }

        out[i] = v;
        const s = out[i];
        sum += s < 128 ? s : 256 - s;
      }

      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }

    raw[row - 1] = best;
    raw.set(candidates[best], row);
  }
}
