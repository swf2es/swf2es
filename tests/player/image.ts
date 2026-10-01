// Images for the player tests: PNGs decoded to RGBA, and two compared as
// Ruffle's image tests compare them, so that its tests' tolerances mean the
// same here: each channel of each pixel that differs by more than the
// tolerance is an outlier, and the images match with no more outliers than
// allowed.
import { deflateSync, inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel, rows top to bottom. */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's pixels as RGBA: 8-bit greyscale, RGB, palette, grey with alpha or RGBA, not interlaced. */
export function decodePng(png: Uint8Array): Image {
  if (!SIGNATURE.every((b, i) => png[i] === b)) {
    throw new Error("not a PNG");
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette: Uint8Array = new Uint8Array(0);
  let transparency: Uint8Array = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (body[8] !== 8 || body[12] !== 0) {
        throw new Error(`PNG of bit depth ${body[8]}, interlace ${body[12]}`);
      }

      colorType = body[9];
    } else if (type === "PLTE") {
      palette = body;
    } else if (type === "tRNS") {
      transparency = body;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }

    at += 12 + length;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) {
    throw new Error(`PNG of colour type ${colorType}`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = unfilter(raw, stride, height, channels);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 6) {
      data.set(rows.subarray(s, s + 4), d);
    } else if (colorType === 2) {
      data.set(rows.subarray(s, s + 3), d);
      data[d + 3] = 255;
    } else if (colorType === 3) {
      const p = rows[s];
      data.set(palette.subarray(p * 3, p * 3 + 3), d);
      data[d + 3] = p < transparency.length ? transparency[p] : 255;
    } else {
      data[d] = data[d + 1] = data[d + 2] = rows[s];
      data[d + 3] = colorType === 4 ? rows[s + 1] : 255;
    }
  }

  return { width, height, data };
}

/** The scanlines with their filters undone, as one buffer without the filter bytes. */
function unfilter(raw: Uint8Array, stride: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[row - stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) {
        v += a;
      } else if (filter === 2) {
        v += b;
      } else if (filter === 3) {
        v += (a + b) >> 1;
      } else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }

      out[row + x] = v & 0xff;
    }
  }

  return out;
}

export interface Comparison {
  /** Channels that differ by more than the tolerance. */
  outliers: number;
  /** The largest difference of any channel. */
  maxDifference: number;
  /** Whether the sizes differ, in which case nothing else was compared. */
  sizeDiffers: boolean;
}

/** `actual` against `expected`, channel by channel, as Ruffle's calculate_outliers. */
export function compareImages(actual: Image, expected: Image, tolerance: number): Comparison {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    return { outliers: Number.POSITIVE_INFINITY, maxDifference: 255, sizeDiffers: true };
  }

  let outliers = 0;
  let maxDifference = 0;
  for (let i = 0; i < actual.data.length; i++) {
    const d = Math.abs(actual.data[i] - expected.data[i]);
    if (d > tolerance) {
      outliers++;
    }

    if (d > maxDifference) {
      maxDifference = d;
    }
  }

  return { outliers, maxDifference, sizeDiffers: false };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}

/** An RGBA image as a PNG, unfiltered. */
export function encodePng(image: Image): Uint8Array {
  const stride = image.width * 4;
  const raw = new Uint8Array((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const chunk = (type: string, body: Uint8Array) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    out.set(body, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Where two images differ: each channel's difference, alpha opaque, for looking at a failure. */
export function differenceImage(a: Image, b: Image): Image {
  const data = new Uint8Array(a.data.length);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.abs(a.data[i] - b.data[i]);
    data[i + 1] = Math.abs(a.data[i + 1] - b.data[i + 1]);
    data[i + 2] = Math.abs(a.data[i + 2] - b.data[i + 2]);
    data[i + 3] = 255;
  }

  return { width: a.width, height: a.height, data };
}

/**
 * `actual` against `expected` with edges allowed to move by a pixel, as two
 * rasterizers' anti-aliasing moves them: a channel is an outlier only when
 * it is further than the tolerance from that channel in each pixel of the
 * other image's 3×3 neighbourhood, both ways. Flat areas still have to match.
 */
export function compareImagesNear(actual: Image, expected: Image, tolerance: number): Comparison {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    return { outliers: Number.POSITIVE_INFINITY, maxDifference: 255, sizeDiffers: true };
  }

  const { width, height } = actual;
  let outliers = 0;
  let maxDifference = 0;
  const nearest = (a: Uint8Array, b: Uint8Array, x: number, y: number, c: number) => {
    const v = a[(y * width + x) * 4 + c];
    let best = 255;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) {
        continue;
      }

      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) {
          continue;
        }

        const d = Math.abs(v - b[(yy * width + xx) * 4 + c]);
        if (d < best) {
          best = d;
        }
      }
    }

    return best;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        const d = Math.max(
          nearest(actual.data, expected.data, x, y, c),
          nearest(expected.data, actual.data, x, y, c),
        );
        if (d > tolerance) {
          outliers++;
        }

        if (d > maxDifference) {
          maxDifference = d;
        }
      }
    }
  }

  return { outliers, maxDifference, sizeDiffers: false };
}
