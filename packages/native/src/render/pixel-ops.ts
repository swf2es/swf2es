// BitmapData's pixel operations in the render module (pixels.zig), over a
// store's pixels a band of rows at a time, so that the scratch stays near
// BAND_BYTES whatever the bitmap's size. Each band is copied in, worked on
// and copied back before the next, which reads what the bands before it
// wrote, as the one loop over the rows did: where the source is the
// destination and a band's rows of the two overlap, they are copied in as
// one block, so that a pixel reads what the pixels before it wrote.
// A band that traps is copied back never, and `Progress` lets the call made
// again in a new instance (BitmapKernel) take up at that band.

/** What pixels.zig's wrapper (bitmap.zig) exports for these. */
export interface PixelExports {
  memory: WebAssembly.Memory;
  resetArena(bytes: number): number;
  channelPixels(params: number): number;
  mergePixels(params: number): number;
  palettePixels(params: number): number;
  matrixPixels(params: number): number;
  transformPixels(params: number): number;
  noisePixels(params: number): number;
  perlinPixels(params: number): number;
}

/** The rows of a band's work: about this much of the pixels it copies in. */
const BAND_BYTES = 1 << 20;
/** The params' room at the input's start, before tables and blocks. */
const HEAD = 256;
/** paletteMap's four tables of 256 entries, after the params. */
const TABLES = 4096;

/** A rect of a store's pixels. */
export interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far a call got: the next band to do, and noise's generator. */
export interface Progress {
  row: number;
  state: number;
}

/** Which copy, and what it writes into the params after pixels.zig's Rows. */
export type CopyOp =
  | { op: "channel"; from: number; to: number }
  | { op: "merge"; muls: readonly [number, number, number, number] }
  | { op: "palette"; tables: readonly [Uint32Array, Uint32Array, Uint32Array, Uint32Array] }
  | {
      op: "matrix";
      matrix: readonly number[];
      near: PixelRegion | null;
      empty: number;
      opaque: boolean;
    };

/**
 * `region` of `into` (`intoWidth` wide) made by the copy `op` of the rows of
 * `from` (`fromWidth` wide) starting at (sx, sy), band by band; false where
 * the module refused a band.
 */
export function copyRows(
  wasm: PixelExports,
  into: Uint32Array,
  intoWidth: number,
  from: Uint32Array,
  fromWidth: number,
  region: PixelRegion,
  sx: number,
  sy: number,
  transparent: boolean,
  op: CopyOp,
  progress: Progress,
): boolean {
  const { x: dx, y: dy, width: w, height: h } = region;
  const same = into === from;
  // A band's blocks: where the source is the destination, both in one block as wide as their union.
  const wide = same ? w + Math.abs(sx - dx) : w;
  const band = Math.max(1, Math.floor(BAND_BYTES / (wide * 8)));
  for (; progress.row < h; progress.row += band) {
    const r0 = progress.row;
    const rows = Math.min(band, h - r0);
    const dy0 = dy + r0;
    const sy0 = sy + r0;
    const joined = same && dy0 < sy0 + rows && sy0 < dy0 + rows;
    const ux = joined ? Math.min(dx, sx) : 0;
    const uy = joined ? Math.min(dy0, sy0) : 0;
    const uw = joined ? Math.max(dx, sx) + w - ux : w;
    const uh = joined ? Math.max(dy0, sy0) + rows - uy : rows;
    const blocks = joined ? uw * uh : 2 * rows * w;
    const at = wasm.resetArena(HEAD + TABLES + blocks * 4);
    if (!at) {
      return false;
    }

    const memory = new Uint32Array(wasm.memory.buffer);
    const base = (at + HEAD + TABLES) >> 2;
    let dst: number;
    let src: number;
    let stride: number;
    if (joined) {
      for (let row = 0; row < uh; row++) {
        const start = (uy + row) * intoWidth + ux;
        memory.set(into.subarray(start, start + uw), base + row * uw);
      }

      dst = base + (dy0 - uy) * uw + (dx - ux);
      src = base + (sy0 - uy) * uw + (sx - ux);
      stride = uw;
    } else {
      dst = base;
      src = base + rows * w;
      stride = w;
      for (let row = 0; row < rows; row++) {
        const to = (dy0 + row) * intoWidth + dx;
        memory.set(into.subarray(to, to + w), dst + row * w);
        const fromAt = (sy0 + row) * fromWidth + sx;
        memory.set(from.subarray(fromAt, fromAt + w), src + row * w);
      }
    }

    const params = new DataView(wasm.memory.buffer, at, HEAD);
    const words = [w, rows, dst * 4, stride, src * 4, stride, Number(transparent), 0];
    for (let k = 0; k < 8; k++) {
      params.setUint32(k * 4, words[k], true);
    }

    let ok = 0;
    switch (op.op) {
      case "channel":
        params.setInt32(32, op.from, true);
        params.setUint32(36, op.to, true);
        ok = wasm.channelPixels(at);
        break;
      case "merge":
        for (let k = 0; k < 4; k++) {
          params.setUint32(32 + k * 4, op.muls[k] >>> 0, true);
        }

        ok = wasm.mergePixels(at);
        break;
      case "palette": {
        params.setUint32(32, at + HEAD, true);
        params.setUint32(36, 0, true);
        const tables = new Uint32Array(wasm.memory.buffer, at + HEAD, 1024);
        for (let k = 0; k < 4; k++) {
          tables.set(op.tables[k], k * 256);
        }

        ok = wasm.palettePixels(at);
        break;
      }
      case "matrix": {
        const near = op.near;
        params.setInt32(32, sx, true);
        params.setInt32(36, sy0, true);
        params.setInt32(40, near?.x ?? 0, true);
        params.setInt32(44, near?.y ?? 0, true);
        params.setUint32(48, near?.width ?? 0, true);
        params.setUint32(52, near?.height ?? 0, true);
        params.setUint32(56, op.empty >>> 0, true);
        params.setUint32(60, op.opaque ? 0xff000000 : 0, true);
        for (let k = 0; k < 20; k++) {
          params.setFloat64(64 + k * 8, op.matrix[k], true);
        }

        ok = wasm.matrixPixels(at);
        break;
      }
    }

    if (!ok) {
      return false;
    }

    // Read again: the call may have grown the memory.
    const out = new Uint32Array(wasm.memory.buffer);
    for (let row = 0; row < rows; row++) {
      const to = (dy0 + row) * intoWidth + dx;
      into.set(out.subarray(dst + row * stride, dst + row * stride + w), to);
    }
  }

  return true;
}

/**
 * colorTransform over `region` of `pixels` (`width` wide), in place, band by
 * band: each channel's multiplier in 256ths and offset, red, green, blue,
 * alpha; false where the module refused a band.
 */
export function transformRows(
  wasm: PixelExports,
  pixels: Uint32Array,
  width: number,
  region: PixelRegion,
  muls: readonly number[],
  adds: readonly number[],
  progress: Progress,
): boolean {
  const { x, y, width: w, height: h } = region;
  const band = Math.max(1, Math.floor(BAND_BYTES / (w * 4)));
  for (; progress.row < h; progress.row += band) {
    const rows = Math.min(band, h - progress.row);
    const at = wasm.resetArena(HEAD + rows * w * 4);
    if (!at) {
      return false;
    }

    const block = (at + HEAD) >> 2;
    const memory = new Uint32Array(wasm.memory.buffer);
    for (let row = 0; row < rows; row++) {
      const from = (y + progress.row + row) * width + x;
      memory.set(pixels.subarray(from, from + w), block + row * w);
    }

    const params = new DataView(wasm.memory.buffer, at, HEAD);
    const words = [w, rows, block * 4, w];
    for (let k = 0; k < words.length; k++) {
      params.setUint32(k * 4, words[k], true);
    }

    for (let k = 0; k < 4; k++) {
      params.setFloat64(16 + k * 8, muls[k], true);
      params.setFloat64(48 + k * 8, adds[k], true);
    }

    if (!wasm.transformPixels(at)) {
      return false;
    }

    const out = new Uint32Array(wasm.memory.buffer);
    for (let row = 0; row < rows; row++) {
      const to = (y + progress.row + row) * width + x;
      pixels.set(out.subarray(block + row * w, block + (row + 1) * w), to);
    }
  }

  return true;
}

/**
 * noise over every pixel, `count` a band: Park-Miller's generator from
 * `progress.state`, which it moves on; false where the module refused a band.
 */
export function noiseRows(
  wasm: PixelExports,
  pixels: Uint32Array,
  lo: number,
  span: number,
  channels: number,
  gray: boolean,
  transparent: boolean,
  progress: Progress,
): boolean {
  const band = BAND_BYTES >> 2;
  for (; progress.row < pixels.length; progress.row += band) {
    const count = Math.min(band, pixels.length - progress.row);
    const at = wasm.resetArena(HEAD + count * 4);
    if (!at) {
      return false;
    }

    const params = new DataView(wasm.memory.buffer, at, HEAD);
    const words = [count, at + HEAD, progress.state, lo, span, channels, Number(gray)];
    words.push(Number(transparent));
    for (let k = 0; k < words.length; k++) {
      params.setUint32(k * 4, words[k] >>> 0, true);
    }

    const state = wasm.noisePixels(at);
    if (!state) {
      return false;
    }

    pixels.set(new Uint32Array(wasm.memory.buffer, at + HEAD, count), progress.row);
    progress.state = state;
  }

  return true;
}

/** perlinNoise's set-up, as turbulence.ts makes it of the seed and the call's arguments. */
export interface PerlinSetup {
  lattice: Int32Array;
  /** Four channels' gradients, x and y interleaved, one after another. */
  gradients: Float64Array;
  offsets: readonly (readonly [number, number])[];
  fx: number;
  fy: number;
  stitch: boolean;
  stitchWidth: number;
  stitchHeight: number;
  fractal: boolean;
  channels: number;
  gray: boolean;
  transparent: boolean;
}

/** perlinNoise over every pixel of a `width`-wide store, band by band; false where the module refused one. */
export function perlinRows(
  wasm: PixelExports,
  pixels: Uint32Array,
  width: number,
  setup: PerlinSetup,
  progress: Progress,
): boolean {
  const height = pixels.length / width;
  const octaves = setup.offsets.length;
  const tables = 2056 + 32896 + octaves * 16;
  const band = Math.max(1, Math.floor(BAND_BYTES / (width * 4)));
  for (; progress.row < height; progress.row += band) {
    const rows = Math.min(band, height - progress.row);
    const at = wasm.resetArena(HEAD + tables + 8 + rows * width * 4);
    if (!at) {
      return false;
    }

    const lattice = at + HEAD;
    const gradients = lattice + 2056 + 8 - ((lattice + 2056) & 7);
    const offsets = gradients + 32896;
    const block = offsets + octaves * 16;
    new Int32Array(wasm.memory.buffer, lattice, 514).set(setup.lattice);
    new Float64Array(wasm.memory.buffer, gradients, 4112).set(setup.gradients);
    const list = new Float64Array(wasm.memory.buffer, offsets, octaves * 2);
    setup.offsets.forEach(([ox, oy], k) => {
      list[k * 2] = ox;
      list[k * 2 + 1] = oy;
    });

    const params = new DataView(wasm.memory.buffer, at, HEAD);
    const words = [width, rows, progress.row, block, lattice, gradients, offsets, octaves];
    words.push(setup.channels, Number(setup.gray), Number(setup.fractal), Number(setup.stitch));
    words.push(Number(setup.transparent), 0);
    for (let k = 0; k < words.length; k++) {
      params.setUint32(k * 4, words[k] >>> 0, true);
    }

    params.setFloat64(56, setup.fx, true);
    params.setFloat64(64, setup.fy, true);
    params.setFloat64(72, setup.stitchWidth, true);
    params.setFloat64(80, setup.stitchHeight, true);
    if (!wasm.perlinPixels(at)) {
      return false;
    }

    pixels.set(new Uint32Array(wasm.memory.buffer, block, rows * width), progress.row * width);
  }

  return true;
}
