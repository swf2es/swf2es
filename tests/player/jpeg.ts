// A JPEG reader for the tests, independent of the encoder it checks
// (packages/native/src/compress/jpeg.zig): sequential DCT files, baseline
// or extended (SOF0, SOF1), Huffman coded, 8 bits a sample, in one
// interleaved scan, which is all Flash's BitmapData.encode writes. It
// gives the file's segments and tables as they are, each component's
// quantized coefficients, and the pixels: an exact inverse DCT in doubles
// and JFIF's colours, the chroma either repeated over the samples it
// covers or, as Flash's decoder and libjpeg since its version 7 make it,
// each block's inverse DCT taken at the size it covers.
import type { Image } from "./image.ts";

interface JpegComponent {
  id: number;
  /** Horizontal and vertical sampling factors. */
  h: number;
  v: number;
  /** Which quantization table it uses. */
  table: number;
  /** Which DC and AC Huffman tables its scan uses. */
  dc: number;
  ac: number;
  /** Blocks across and down, whole MCUs. */
  columns: number;
  rows: number;
  /** Its quantized coefficients: 64 a block in natural (row) order, blocks row by row. */
  coefficients: Int16Array;
}

interface JpegHuffman {
  /** 0 for a DC table, 1 for an AC one. */
  kind: number;
  id: number;
  /** How many codes there are of each length, 1 to 16 bits. */
  counts: number[];
  values: number[];
}

export interface Jpeg extends Image {
  /** The markers' second bytes, in the file's order, from SOI to EOI. */
  markers: number[];
  /** The frame's marker: 0xc0 baseline, 0xc1 extended sequential. */
  frame: number;
  /** The APP0 segment's bytes after its length, if there is one. */
  jfif: Uint8Array | null;
  /** Each DQT table in the file's order: its precision (0 for bytes, 1 for 16 bits) and its values in natural order. */
  quantization: { id: number; precision: number; values: number[] }[];
  huffman: JpegHuffman[];
  components: JpegComponent[];
  restartInterval: number;
}

/** Where the k-th coefficient of a zigzag scan is in a block's rows. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

interface Lookup {
  /** For each code length, the smallest code and the index of its value; maxCode -1 where none. */
  minCode: number[];
  maxCode: number[];
  first: number[];
  values: number[];
}

function lookup(table: JpegHuffman): Lookup {
  const minCode: number[] = [];
  const maxCode: number[] = [];
  const first: number[] = [];
  let code = 0;
  let at = 0;
  for (let length = 1; length <= 16; length++) {
    const n = table.counts[length - 1];
    minCode[length] = code;
    first[length] = at;
    maxCode[length] = n ? code + n - 1 : -1;
    code = (code + n) << 1;
    at += n;
  }

  return { minCode, maxCode, first, values: table.values };
}

/**
 * A block's samples from its dequantized coefficients, less the level shift: `across` by
 * `down` of them, 8 by 8 for the block itself and more for one that covers more.
 */
function inverse(block: Float64Array, across: number, down: number): Float64Array {
  const basis = (n: number) => {
    const out = new Float64Array(n * 8);
    for (let x = 0; x < n; x++) {
      for (let u = 0; u < 8; u++) {
        out[x * 8 + u] =
          (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
      }
    }

    return out;
  };
  const bx = basis(across);
  const by = basis(down);
  const half = new Float64Array(8 * across);
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < across; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) {
        sum += bx[x * 8 + u] * block[v * 8 + u];
      }

      half[v * across + x] = sum;
    }
  }

  const out = new Float64Array(across * down);
  for (let y = 0; y < down; y++) {
    for (let x = 0; x < across; x++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        sum += by[y * 8 + v] * half[v * across + x];
      }

      out[y * across + x] = sum;
    }
  }

  return out;
}

/**
 * A JPEG file read whole; throws on what it does not read or what is malformed. With `scaled`,
 * a component kept at less than full size is brought to it by its blocks' inverse DCTs, as
 * Flash decodes; otherwise its samples are repeated.
 */
export function decodeJpeg(file: Uint8Array, scaled = false): Jpeg {
  if (file[0] !== 0xff || file[1] !== 0xd8) {
    throw new Error("not a JPEG");
  }

  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const markers = [0xd8];
  const quantization: Jpeg["quantization"] = [];
  const huffman: JpegHuffman[] = [];
  const components: JpegComponent[] = [];
  let jfif: Uint8Array | null = null;
  let frame = 0;
  let width = 0;
  let height = 0;
  let restartInterval = 0;
  let at = 2;
  for (;;) {
    if (file[at] !== 0xff) {
      throw new Error(`no marker at ${at}`);
    }

    const marker = file[at + 1];
    const length = view.getUint16(at + 2);
    const body = file.subarray(at + 4, at + 2 + length);
    markers.push(marker);
    at += 2 + length;
    if (marker === 0xe0) {
      jfif = body;
    } else if (marker === 0xdb) {
      for (let p = 0; p < body.length; ) {
        const precision = body[p] >> 4;
        const id = body[p] & 15;
        p++;
        const values = new Array<number>(64);
        for (let k = 0; k < 64; k++) {
          values[ZIGZAG[k]] = precision ? (body[p] << 8) | body[p + 1] : body[p];
          p += precision ? 2 : 1;
        }

        quantization.push({ id, precision, values });
      }
    } else if (marker === 0xc4) {
      for (let p = 0; p < body.length; ) {
        const counts = [...body.subarray(p + 1, p + 17)];
        const total = counts.reduce((a, n) => a + n, 0);
        huffman.push({
          kind: body[p] >> 4,
          id: body[p] & 15,
          counts,
          values: [...body.subarray(p + 17, p + 17 + total)],
        });
        p += 17 + total;
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      frame = marker;
      if (body[0] !== 8) {
        throw new Error(`JPEG of ${body[0]} bits a sample`);
      }

      height = (body[1] << 8) | body[2];
      width = (body[3] << 8) | body[4];
      for (let c = 0; c < body[5]; c++) {
        components.push({
          id: body[6 + c * 3],
          h: body[7 + c * 3] >> 4,
          v: body[7 + c * 3] & 15,
          table: body[8 + c * 3],
          dc: 0,
          ac: 0,
          columns: 0,
          rows: 0,
          coefficients: new Int16Array(0),
        });
      }
    } else if (marker === 0xdd) {
      restartInterval = (body[0] << 8) | body[1];
    } else if (marker === 0xda) {
      if (body[0] !== components.length) {
        throw new Error("JPEG of more than one scan");
      }

      for (let c = 0; c < body[0]; c++) {
        const component = components.find((x) => x.id === body[1 + c * 2]);
        if (!component) {
          throw new Error("a scan of a component the frame has not");
        }

        component.dc = body[2 + c * 2] >> 4;
        component.ac = body[2 + c * 2] & 15;
      }

      break;
    } else if (marker >= 0xc2 && marker <= 0xcf) {
      throw new Error(`JPEG frame ${marker.toString(16)}`);
    }
  }

  if (!frame || width === 0 || height === 0) {
    throw new Error("JPEG scan before a frame");
  }

  const hMax = Math.max(...components.map((c) => c.h));
  const vMax = Math.max(...components.map((c) => c.v));
  const mcuColumns = Math.ceil(width / (8 * hMax));
  const mcuRows = Math.ceil(height / (8 * vMax));
  for (const c of components) {
    c.columns = mcuColumns * c.h;
    c.rows = mcuRows * c.v;
    c.coefficients = new Int16Array(c.columns * c.rows * 64);
  }

  // The scan's bits, its stuffed zeros dropped; a marker ends them.
  let bits = 0;
  let count = 0;
  let ended = false;
  const bit = (): number => {
    if (count === 0) {
      if (ended) {
        throw new Error("JPEG scan ends early");
      }

      bits = file[at++];
      if (bits === 0xff) {
        if (file[at] === 0) {
          at++;
        } else {
          ended = true;
          at--;
          bits = 0;
        }
      }

      count = 8;
    }

    count--;
    return (bits >> count) & 1;
  };
  const receive = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | bit();
    }

    // A value of n bits whose first is 0 is negative.
    return n && v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  };
  const symbol = (t: Lookup): number => {
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      code = (code << 1) | bit();
      if (t.maxCode[length] >= 0 && code <= t.maxCode[length]) {
        return t.values[t.first[length] + code - t.minCode[length]];
      }
    }

    throw new Error("no such Huffman code");
  };
  const tables = (kind: number, id: number): Lookup => {
    // The last table of an id is the one in force.
    const table = huffman.filter((t) => t.kind === kind && t.id === id).pop();
    if (!table) {
      throw new Error(`no Huffman table ${kind}/${id}`);
    }

    return lookup(table);
  };
  const dc = components.map((c) => tables(0, c.dc));
  const ac = components.map((c) => tables(1, c.ac));
  const predictions = components.map(() => 0);
  for (let mcu = 0; mcu < mcuColumns * mcuRows; mcu++) {
    if (restartInterval && mcu && mcu % restartInterval === 0) {
      count = 0;
      ended = false;
      if (file[at] !== 0xff || (file[at + 1] & 0xf8) !== 0xd0) {
        throw new Error("no restart marker");
      }

      at += 2;
      predictions.fill(0);
    }

    const mx = mcu % mcuColumns;
    const my = (mcu - mx) / mcuColumns;
    for (let i = 0; i < components.length; i++) {
      const c = components[i];
      for (let by = 0; by < c.v; by++) {
        for (let bx = 0; bx < c.h; bx++) {
          const base = ((my * c.v + by) * c.columns + mx * c.h + bx) * 64;
          predictions[i] += receive(symbol(dc[i]));
          c.coefficients[base] = predictions[i];
          for (let k = 1; k < 64; ) {
            const rs = symbol(ac[i]);
            const size = rs & 15;
            if (size === 0) {
              if (rs !== 0xf0) {
                break;
              }

              k += 16;
              continue;
            }

            k += rs >> 4;
            if (k > 63) {
              throw new Error("a run past the block");
            }

            c.coefficients[base + ZIGZAG[k]] = receive(size);
            k++;
          }
        }
      }
    }
  }

  // Past the padding bits is the end of the image.
  count = 0;
  if (!ended && (file[at] !== 0xff || file[at + 1] !== 0xd9)) {
    throw new Error("JPEG scan does not end in EOI");
  }

  markers.push(0xd9);

  const planes = components.map((c) => {
    const q = quantization.filter((t) => t.id === c.table).pop();
    if (!q) {
      throw new Error(`no quantization table ${c.table}`);
    }

    // How many samples of the plane a block makes each way.
    const across = scaled ? (8 * hMax) / c.h : 8;
    const down = scaled ? (8 * vMax) / c.v : 8;
    const stride = c.columns * across;
    const samples = new Float64Array(stride * c.rows * down);
    const block = new Float64Array(64);
    for (let b = 0; b < c.columns * c.rows; b++) {
      for (let k = 0; k < 64; k++) {
        block[k] = c.coefficients[b * 64 + k] * q.values[k];
      }

      const made = inverse(block, across, down);
      const x0 = (b % c.columns) * across;
      const y0 = Math.floor(b / c.columns) * down;
      for (let y = 0; y < down; y++) {
        for (let x = 0; x < across; x++) {
          samples[(y0 + y) * stride + x0 + x] = made[y * across + x] + 128;
        }
      }
    }

    return { samples, stride, h: (across * c.h) / 8, v: (down * c.v) / 8 };
  });
  const data = new Uint8Array(width * height * 4);
  const sample = (i: number, x: number, y: number): number => {
    const plane = planes[i];
    const sx = Math.floor((x * plane.h) / hMax);
    const sy = Math.floor((y * plane.v) / vMax);
    return plane.samples[sy * plane.stride + sx];
  };
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const luma = sample(0, x, y);
      if (components.length === 3) {
        const cb = sample(1, x, y) - 128;
        const cr = sample(2, x, y) - 128;
        data[i] = byte(luma + 1.402 * cr);
        data[i + 1] = byte(luma - 0.344136 * cb - 0.714136 * cr);
        data[i + 2] = byte(luma + 1.772 * cb);
      } else {
        data[i] = data[i + 1] = data[i + 2] = byte(luma);
      }

      data[i + 3] = 255;
    }
  }

  return {
    width,
    height,
    data,
    markers,
    frame,
    jfif,
    quantization,
    huffman,
    components,
    restartInterval,
  };
}
