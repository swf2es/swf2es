// S3TC's DXT1 and DXT5 on the CPU: blocks decoded to RGBA for a backend
// whose GPU takes no S3TC (WEBGL_compressed_texture_s3tc absent), and RGBA
// encoded to blocks for pixels uploaded to a compressed texture, which AIR
// compresses too. DXT1 is "compressed": a block whose first colour is not
// above its second has a third, the midpoint, and transparent black for its
// fourth index, as AIR draws it (GL's COMPRESSED_RGBA_S3TC_DXT1). DXT5's
// colours always have four.

/** RGB565 as 0xRRGGBB, each channel's high bits repeated into its low ones. */
function rgb(c: number): number {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  return (((r << 3) | (r >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((b << 3) | (b >> 2));
}

/** `a` weighted `wa` against `b`, per channel of two 0xRRGGBB colours, over `total`. */
function mix(a: number, b: number, wa: number, wb: number, total: number): number {
  let out = 0;
  for (let shift = 0; shift < 24; shift += 8) {
    const channel = ((((a >> shift) & 255) * wa + ((b >> shift) & 255) * wb) / total) | 0;
    out |= channel << shift;
  }

  return out;
}

/** DXT1's fourth colour where a block has three: black, and the one transparent texel. */
const TRANSPARENT = -1;

const palette = new Int32Array(4);
const texels = new Int32Array(16);
const alphas = new Uint8Array(8);

/** A whole RGBA level encoded to DXT blocks; null uses the TypeScript encoder. */
export type DxtEncoder = (
  rgba: Uint8Array,
  dxt5: boolean,
  width: number,
  height: number,
) => Uint8Array | null;

/**
 * `blocks`, a level `width` by `height` of DXT1 (8 bytes a 4x4 block) or,
 * with `dxt5`, DXT5 (16), rows of blocks from the top, written to `out` as
 * top-down RGBA rows of `width` pixels. The level's edge blocks may stand
 * past it, as a 2x2 level's one block does; what stands past is dropped.
 */
export function decodeDxt(
  blocks: Uint8Array,
  dxt5: boolean,
  width: number,
  height: number,
  out: Uint8Array,
): void {
  const size = dxt5 ? 16 : 8;
  const across = Math.max(1, (width + 3) >> 2);
  const down = Math.max(1, (height + 3) >> 2);

  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      const at = (by * across + bx) * size;
      const colour = dxt5 ? at + 8 : at;
      const c0 = blocks[colour] | (blocks[colour + 1] << 8);
      const c1 = blocks[colour + 2] | (blocks[colour + 3] << 8);
      palette[0] = rgb(c0);
      palette[1] = rgb(c1);
      if (dxt5 || c0 > c1) {
        palette[2] = mix(palette[0], palette[1], 2, 1, 3);
        palette[3] = mix(palette[0], palette[1], 1, 2, 3);
      } else {
        palette[2] = mix(palette[0], palette[1], 1, 1, 2);
        palette[3] = TRANSPARENT;
      }

      if (dxt5) {
        const a0 = blocks[at];
        const a1 = blocks[at + 1];
        alphas[0] = a0;
        alphas[1] = a1;
        if (a0 > a1) {
          for (let i = 1; i < 7; i++) {
            alphas[i + 1] = (((7 - i) * a0 + i * a1) / 7) | 0;
          }
        } else {
          for (let i = 1; i < 5; i++) {
            alphas[i + 1] = (((5 - i) * a0 + i * a1) / 5) | 0;
          }
          alphas[6] = 0;
          alphas[7] = 255;
        }
      }

      const indices =
        (blocks[colour + 4] |
          (blocks[colour + 5] << 8) |
          (blocks[colour + 6] << 16) |
          (blocks[colour + 7] << 24)) >>>
        0;
      // DXT5's 48 bits of 3-bit alpha indices, as two 24-bit halves.
      const low = dxt5 ? blocks[at + 2] | (blocks[at + 3] << 8) | (blocks[at + 4] << 16) : 0;
      const high = dxt5 ? blocks[at + 5] | (blocks[at + 6] << 8) | (blocks[at + 7] << 16) : 0;
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= height) {
          break;
        }

        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x;
          if (px >= width) {
            break;
          }

          const i = y * 4 + x;
          const c = palette[(indices >>> (i * 2)) & 3];
          const o = (py * width + px) * 4;
          if (c === TRANSPARENT) {
            out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
            continue;
          }

          out[o] = c >> 16;
          out[o + 1] = c >> 8;
          out[o + 2] = c;
          out[o + 3] = dxt5 ? alphas[(i < 8 ? low >> (i * 3) : high >> ((i - 8) * 3)) & 7] : 255;
        }
      }
    }
  }
}

/** A colour's distance from palette entry `c`, squared, per channel. */
function distance(r: number, g: number, b: number, c: number): number {
  const dr = r - ((c >> 16) & 255);
  const dg = g - ((c >> 8) & 255);
  const db = b - (c & 255);
  return dr * dr + dg * dg + db * db;
}

/** 0xRRGGBB as RGB565. */
function pack(r: number, g: number, b: number): number {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/** The bytes of a level `width` by `height` as DXT1's blocks, or DXT5's: one block at least. */
export function blockBytes(width: number, height: number, dxt5: boolean): number {
  return Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * (dxt5 ? 16 : 8);
}

/** encodeDxt's output, kept for the next level: each upload copies its blocks out at once. */
let encoded = new Uint8Array(0);

/**
 * `rgba`, top-down RGBA rows of `width` pixels, `height` high, as blocks,
 * DXT1's or with `dxt5` DXT5's, for `decodeDxt` or a GPU: each block's
 * colours on the line through them that their spread runs along (its
 * principal axis, by a few power iterations), between the pixels that lie
 * farthest out on it, four of them always; DXT5's alpha between its lowest
 * and highest, eight. A level smaller than a block repeats its pixels across
 * it. The result is a view of a buffer the next call reuses.
 */
export function encodeDxt(
  rgba: Uint8Array,
  dxt5: boolean,
  width: number,
  height: number,
): Uint8Array {
  const size = dxt5 ? 16 : 8;
  const across = Math.max(1, (width + 3) >> 2);
  const down = Math.max(1, (height + 3) >> 2);
  const length = blockBytes(width, height, dxt5);
  if (encoded.length < length) {
    encoded = new Uint8Array(length);
  }

  const out = encoded;

  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      const at = (by * across + bx) * size;
      // The block's pixels, its edge repeated past a level smaller than a block.
      let mr = 0;
      let mg = 0;
      let mb = 0;
      let lowA = 255;
      let highA = 0;
      for (let i = 0; i < 16; i++) {
        const p =
          (Math.min(by * 4 + (i >> 2), height - 1) * width +
            Math.min(bx * 4 + (i & 3), width - 1)) *
          4;
        texels[i] = p;
        mr += rgba[p];
        mg += rgba[p + 1];
        mb += rgba[p + 2];
        lowA = Math.min(lowA, rgba[p + 3]);
        highA = Math.max(highA, rgba[p + 3]);
      }

      mr /= 16;
      mg /= 16;
      mb /= 16;
      // The colours' covariance, and its principal axis.
      let rr = 0;
      let rg = 0;
      let rb = 0;
      let gg = 0;
      let gb = 0;
      let bb = 0;
      for (let i = 0; i < 16; i++) {
        const p = texels[i];
        const r = rgba[p] - mr;
        const g = rgba[p + 1] - mg;
        const b = rgba[p + 2] - mb;
        rr += r * r;
        rg += r * g;
        rb += r * b;
        gg += g * g;
        gb += g * b;
        bb += b * b;
      }

      // Iterated from the pixel farthest from the mean, which no axis is orthogonal to.
      let vr = 0;
      let vg = 0;
      let vb = 0;
      let spread = -1;
      for (let i = 0; i < 16; i++) {
        const p = texels[i];
        const r = rgba[p] - mr;
        const g = rgba[p + 1] - mg;
        const b = rgba[p + 2] - mb;
        if (r * r + g * g + b * b > spread) {
          spread = r * r + g * g + b * b;
          vr = r;
          vg = g;
          vb = b;
        }
      }

      for (let k = 0; k < 4; k++) {
        const nr = rr * vr + rg * vg + rb * vb;
        const ng = rg * vr + gg * vg + gb * vb;
        const nb = rb * vr + gb * vg + bb * vb;
        const m = Math.max(Math.abs(nr), Math.abs(ng), Math.abs(nb));
        if (m === 0) {
          break;
        }
        vr = nr / m;
        vg = ng / m;
        vb = nb / m;
      }

      // The pixels farthest out along it, either way, are the endpoints.
      let first = texels[0];
      let second = texels[0];
      let least = Infinity;
      let most = -Infinity;
      for (let i = 0; i < 16; i++) {
        const p = texels[i];
        const d = rgba[p] * vr + rgba[p + 1] * vg + rgba[p + 2] * vb;
        if (d < least) {
          least = d;
          second = p;
        }
        if (d > most) {
          most = d;
          first = p;
        }
      }

      // Four colours need the first endpoint above the second; one alike stays one.
      let c0 = pack(rgba[first], rgba[first + 1], rgba[first + 2]);
      let c1 = pack(rgba[second], rgba[second + 1], rgba[second + 2]);
      if (c0 < c1) {
        const swap = c0;
        c0 = c1;
        c1 = swap;
      }

      palette[0] = rgb(c0);
      palette[1] = rgb(c1);
      palette[2] = mix(palette[0], palette[1], 2, 1, 3);
      palette[3] = mix(palette[0], palette[1], 1, 2, 3);
      const colour = dxt5 ? at + 8 : at;
      out[colour] = c0;
      out[colour + 1] = c0 >> 8;
      out[colour + 2] = c1;
      out[colour + 3] = c1 >> 8;
      if (dxt5) {
        // Eight alphas: the first endpoint above the second, or alike.
        alphas[0] = highA;
        alphas[1] = lowA;
        for (let i = 1; i < 7; i++) {
          alphas[i + 1] = (((7 - i) * highA + i * lowA) / 7) | 0;
        }
        out[at] = highA;
        out[at + 1] = lowA;
      }

      let indices = 0;
      let low = 0;
      let high = 0;
      const colours = c0 === c1 ? 1 : 4;
      for (let i = 0; i < 16; i++) {
        const o = texels[i];
        let best = 0;
        let nearest = Infinity;
        for (let p = 0; p < colours; p++) {
          const d = distance(rgba[o], rgba[o + 1], rgba[o + 2], palette[p]);
          if (d < nearest) {
            nearest = d;
            best = p;
          }
        }
        indices |= best << (i * 2);
        if (dxt5) {
          let index = 0;
          for (let p = 1; p < 8; p++) {
            if (Math.abs(rgba[o + 3] - alphas[p]) < Math.abs(rgba[o + 3] - alphas[index])) {
              index = p;
            }
          }
          if (i < 8) {
            low |= index << (i * 3);
          } else {
            high |= index << ((i - 8) * 3);
          }
        }
      }

      out[colour + 4] = indices;
      out[colour + 5] = indices >>> 8;
      out[colour + 6] = indices >>> 16;
      out[colour + 7] = indices >>> 24;
      if (dxt5) {
        out[at + 2] = low;
        out[at + 3] = low >> 8;
        out[at + 4] = low >> 16;
        out[at + 5] = high;
        out[at + 6] = high >> 8;
        out[at + 7] = high >> 16;
      }
    }
  }

  return out.subarray(0, length);
}
