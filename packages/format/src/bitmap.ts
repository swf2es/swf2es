// The SWF's bitmap tags. The lossless formats are read here to pixels; the
// JPEG tags hold an image (a JPEG, PNG or GIF) for the player to decode,
// with what Flash does to its bytes first already done.
import { zlibUncompress } from "./compression.js";
import type { Tag } from "./swf.js";
import {
  DefineBits,
  DefineBitsJPEG2,
  DefineBitsJPEG3,
  DefineBitsJPEG4,
  DefineBitsLossless,
  DefineBitsLossless2,
} from "./tags.js";

export type Bitmap =
  /** Premultiplied ARGB, row by row. */
  | {
      id: number;
      type: "pixels";
      width: number;
      height: number;
      transparent: boolean;
      pixels: Uint32Array;
    }
  | {
      id: number;
      type: "image";
      format: "jpeg" | "png" | "gif";
      /** The file, as a decoder takes it. */
      data: Uint8Array;
      /** DefineBitsJPEG3's alpha, a byte a pixel, for a JPEG; null for none. */
      alpha: Uint8Array | null;
      /** DefineBitsJPEG4: Flash shows it opaque though it reports it transparent. */
      opaque: boolean;
    }
  /** What Flash cannot read: a bitmap of 0 by 0. */
  | { id: number; type: "invalid" };

/** Whether a tag defines a bitmap. */
export function isBitmapTag(code: number): boolean {
  return (
    code === DefineBits ||
    code === DefineBitsJPEG2 ||
    code === DefineBitsJPEG3 ||
    code === DefineBitsJPEG4 ||
    code === DefineBitsLossless ||
    code === DefineBitsLossless2
  );
}

/**
 * A bitmap tag's character. `tables` is the JPEGTables tag's data that
 * DefineBits needs, null if there was none.
 */
export function readBitmap(bytes: Uint8Array, tag: Tag, tables: Uint8Array | null): Bitmap {
  const body = bytes.subarray(tag.offset, tag.offset + tag.length);
  const id = body.length >= 2 ? body[0] | (body[1] << 8) : 0;
  // Flash refuses a bitmap tag written with the short header, whatever it holds.
  if (!tag.long || body.length < 2) {
    return { id, type: "invalid" };
  }

  try {
    switch (tag.code) {
      case DefineBitsLossless:
      case DefineBitsLossless2:
        return lossless(id, body, tag.code === DefineBitsLossless2);
      case DefineBits:
        return tables ? image(id, concat(tables, body.subarray(2)), null, false) : invalid(id);
      case DefineBitsJPEG2:
        return image(id, body.subarray(2), null, false);
      default: {
        const size = u32(body, 2);
        const start = tag.code === DefineBitsJPEG4 ? 8 : 6;
        if (start + size > body.length) {
          return invalid(id);
        }

        const alpha = zlibUncompress(body.subarray(start + size));
        return image(id, body.subarray(start, start + size), alpha, tag.code === DefineBitsJPEG4);
      }
    }
  } catch {
    // Corrupt zlib data.
    return invalid(id);
  }
}

function invalid(id: number): Bitmap {
  return { id, type: "invalid" };
}

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function image(id: number, data: Uint8Array, alpha: Uint8Array | null, jpeg4: boolean): Bitmap {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    // A PNG or GIF keeps its own alpha; the tag's is ignored.
    return { id, type: "image", format: "png", data, alpha: null, opaque: false };
  }

  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return { id, type: "image", format: "gif", data, alpha: null, opaque: false };
  }

  const jpeg = cleanJpeg(data);
  if (!jpeg) {
    return invalid(id);
  }

  return {
    id,
    type: "image",
    format: "jpeg",
    data: jpeg,
    alpha: jpeg4 ? null : alpha,
    opaque: jpeg4,
  };
}

/**
 * A JPEG as a decoder takes it: one SOI, then its segments, with the EOI
 * and SOI between tables and image that SWFs carry dropped. Old tools
 * wrote a stray FF D9 FF D8 at the start, and DefineBits' tables come as
 * a JPEG of their own; Flash reads both. Null if it is not a JPEG.
 */
function cleanJpeg(data: Uint8Array): Uint8Array | null {
  const out: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  let at = 0;
  while (at + 1 < data.length) {
    if (data[at] !== 0xff) {
      return null;
    }

    const marker = data[at + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      at += 2;
      continue;
    }

    if (marker === 0xff) {
      // Fill bytes before a marker.
      at++;
      continue;
    }

    if (marker === 0xda) {
      // The scan, and everything after it, as it is.
      out.push(data.subarray(at));
      return concatAll(out);
    }

    if (at + 3 >= data.length) {
      return null;
    }

    const end = at + 2 + ((data[at + 2] << 8) | data[at + 3]);
    out.push(data.subarray(at, end));
    at = end;
  }

  return null;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }

  return out;
}

/** DefineBitsLossless and 2: a palette, 15-bit or 32-bit pixels, zlib'd. */
function lossless(id: number, body: Uint8Array, alpha: boolean): Bitmap {
  if (body.length < 7) {
    return invalid(id);
  }

  const format = body[2];
  const width = u16(body, 3);
  const height = u16(body, 5);
  if (width === 0 || height === 0 || (format !== 3 && format !== 4 && format !== 5)) {
    return invalid(id);
  }

  const colors = format === 3 ? body[7] + 1 : 0;
  const data = zlibUncompress(body.subarray(format === 3 ? 8 : 7));
  const pixels = new Uint32Array(width * height);
  if (format === 3) {
    const entry = alpha ? 4 : 3;
    const palette = new Uint32Array(256);
    for (let i = 0; i < colors; i++) {
      const p = i * entry;
      // Lossless2's palette is premultiplied ARGB, as its pixels are.
      palette[i] = alpha
        ? ((data[p + 3] << 24) | (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]) >>> 0
        : (0xff000000 | (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]) >>> 0;
    }

    const stride = (width + 3) & ~3;
    const start = colors * entry;
    if (start + stride * (height - 1) + width > data.length) {
      return invalid(id);
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        pixels[y * width + x] = palette[data[start + y * stride + x]];
      }
    }
  } else if (format === 4) {
    // 15-bit RGB, rows padded to 4 bytes; a channel v is v * 8 + 7, 0 kept at 0.
    const stride = (width * 2 + 3) & ~3;
    if (stride * (height - 1) + width * 2 > data.length) {
      return invalid(id);
    }

    const widen = (v: number) => (v === 0 ? 0 : v * 8 + 7);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * stride + x * 2;
        const v = (data[p] << 8) | data[p + 1];
        pixels[y * width + x] =
          (0xff000000 |
            (widen((v >> 10) & 31) << 16) |
            (widen((v >> 5) & 31) << 8) |
            widen(v & 31)) >>>
          0;
      }
    }
  } else {
    if (width * height * 4 > data.length) {
      return invalid(id);
    }

    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      const rgb = (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3];
      pixels[i] = alpha ? ((data[p] << 24) | rgb) >>> 0 : (0xff000000 | rgb) >>> 0;
    }
  }

  return { id, type: "pixels", width, height, transparent: alpha, pixels };
}
