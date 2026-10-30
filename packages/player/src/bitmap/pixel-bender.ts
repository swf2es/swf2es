// Pixel Bender kernels run on the CPU, a pixel at a time, as Flash runs a
// ShaderJob: float registers in float32, int registers in int32, every
// register zero at each pixel's start but for the parameters and
// _OutCoord, the pixel's centre. What each operation does is what adl
// does, odd as some of it is: equal and notEqual only of scalars, a
// comparison's result in i0 whatever its destination, a bool
// turned to float as the bits of the int 1, a loaded int cut to 16 bits.
// A BitmapData samples as its premultiplied bytes, linearly in 8-bit
// steps; the edges clamp. The operations are compiled once a kernel into
// a flat program of fixed-size instructions.
import {
  type PbjCompute,
  type PbjIf,
  type PbjKernel,
  type PbjLoad,
  PbjOp,
  type PbjOperation,
  type PbjParameter,
  type PbjRegister,
  type PbjSample,
  type PbjSelect,
} from "@swf2es/format";
import { type BitmapStore, nearest, type PixelRect } from "./bitmap.js";

/** An image a kernel samples: a BitmapData's premultiplied ARGB, or floats, `channels` a pixel. */
export interface ShaderImage {
  width: number;
  height: number;
  pixels?: Uint32Array;
  floats?: Float32Array;
  /** The floats' channels a pixel. */
  channels: number;
  /** Transparent past its edges, as a filter's source is, rather than clamped to them. */
  clear?: boolean;
}

/** A kernel with what it runs with: its parameters' numbers, and its inputs' images by texture number. */
export interface ShaderUse {
  kernel: PbjKernel;
  values: Map<PbjParameter, number[]>;
  images: Map<number, ShaderImage>;
}

/** The name Pixel Bender gives the parameter it sets to the pixel's coordinate. */
export const OUT_COORD = "_OutCoord";

const STRIDE = 20;
// Instruction words: the kind, the lanes, an auxiliary value, then the
// destination's offsets, the source's, and a second and third source's.
const KIND = 0;
const LANES = 1;
const AUX = 2;
const DST = 4;
const SRC = 8;
const SRC2 = 12;
const SRC3 = 16;

/** Instruction kinds past PBJ's opcodes: an operation on int registers is its opcode plus INT. */
const INT = 0x100;
const MATRIX = 0x200;
const NOTHING = 0x400;
const JUMP = 0x401;
const JUMP_UNLESS = 0x402;
const LOAD_F = 0x403;
const LOAD_I = 0x404;
const SELECT_F = 0x405;
const SELECT_I = 0x406;
const SAMPLE_NEAREST = 0x407;
const SAMPLE_LINEAR = 0x408;

/** A byte's float as adl samples one: times the float nearest 1/255, not divided. */
const BYTE = Math.fround(1 / 255);

const bitsF = new Float32Array(1);
const bitsI = new Int32Array(bitsF.buffer);

/** The nearest int, a half to the even one, as SSE converts; INT_MIN past int's range or for NaN. */
function toInt(v: number): number {
  const r = nearest(v);
  return r >= -2147483648 && r <= 2147483647 ? r : -2147483648;
}

/** Registers numbered as the kernel numbers them, packed into slots of four lanes. */
class Slots {
  readonly map = new Map<number, number>();

  slot(index: number): number {
    let slot = this.map.get(index);
    if (slot === undefined) {
      slot = this.map.size;
      this.map.set(index, slot);
    }

    return slot * 4;
  }
}

export class PixelBender {
  private readonly code: Int32Array;
  /** Each instruction's float to load, by its number. */
  private readonly constants: Float32Array;
  private readonly f: Float32Array;
  private readonly i: Int32Array;
  /** The registers as each pixel starts, the parameters set. */
  private readonly f0: Float32Array;
  private readonly i0: Int32Array;
  private readonly images: (ShaderImage | null)[] = [];
  /** A matrix product's, or a vector's, values while it is written. */
  private readonly scratch = new Float32Array(16);
  private readonly coord: number[] = [];
  private readonly out: number[] = [];
  private readonly floats: Slots;
  private readonly ints: Slots;
  /** The output parameter: the last declared, as Flash takes it. */
  readonly output: PbjParameter;
  /** The textures the operations sample, by number. */
  readonly sampled = new Set<number>();

  constructor(readonly kernel: PbjKernel) {
    this.floats = new Slots();
    this.ints = new Slots();
    const outputs = kernel.parameters.filter((p) => p.output);
    this.output = outputs[outputs.length - 1];
    this.constants = new Float32Array(kernel.operations.length);
    this.code = this.compile(kernel.operations);
    for (const p of kernel.parameters) {
      this.columns(p.register);
    }

    const coord = kernel.parameters.find((p) => !p.output && p.name === OUT_COORD);
    if (coord && !coord.register.int && !coord.register.matrix) {
      this.coord = this.offsets(coord.register);
    }

    // An int output gives 0, as in adl: lanes of a register nothing writes.
    const out = this.output.register;
    this.out = out.int ? out.channels.map((c) => this.floats.slot(-1) + c) : this.offsets(out);
    this.f = new Float32Array(Math.max(4, this.floats.map.size * 4));
    this.i = new Int32Array(Math.max(4, this.ints.map.size * 4));
    this.f0 = new Float32Array(this.f.length);
    this.i0 = new Int32Array(this.i.length);
  }

  /** The output's channels a pixel. */
  get channels(): number {
    return this.out.length;
  }

  private slots(r: PbjRegister): Slots {
    return r.int ? this.ints : this.floats;
  }

  /** A register's offsets, a lane each: a destination's written channels, a source's swizzle. */
  private offsets(r: PbjRegister): number[] {
    const base = this.slots(r).slot(r.index);
    return r.channels.map((c) => base + c);
  }

  /** A matrix's columns' first offsets: a 2x2 matrix is one register, its columns in two lanes each. */
  private columns(r: PbjRegister): number[] {
    if (!r.matrix) {
      return [];
    }

    const s = this.slots(r);
    if (r.matrix === 2) {
      const base = s.slot(r.index);
      return [base, base + 2];
    }

    return Array.from({ length: r.matrix }, (_, c) => s.slot(r.index + c));
  }

  private compile(operations: PbjOperation[]): Int32Array {
    const code = new Int32Array(operations.length * STRIDE);
    const open: { at: number; otherwise: number }[] = [];
    for (const [n, op] of operations.entries()) {
      const at = n * STRIDE;
      const put = (offset: number, values: number[]) => {
        for (const [k, v] of values.entries()) {
          code[at + offset + k] = v;
        }
      };

      switch (op.op) {
        case PbjOp.load: {
          const o = op as PbjLoad;
          code[at + KIND] = o.dst.int ? LOAD_I : LOAD_F;
          code[at + LANES] = o.dst.size;
          put(DST, this.offsets(o.dst));
          // An int in the third source's words, a float in constants.
          code[at + SRC3] = o.dst.int ? o.value : 0;
          this.constants[n] = o.dst.int ? 0 : o.value;
          break;
        }

        case PbjOp.sampleNearest:
        case PbjOp.sampleLinear: {
          const o = op as PbjSample;
          code[at + KIND] = o.op === PbjOp.sampleLinear ? SAMPLE_LINEAR : SAMPLE_NEAREST;
          code[at + LANES] = o.dst.size;
          code[at + AUX] = o.texture;
          put(DST, this.offsets(o.dst));
          put(SRC, this.offsets(o.src));
          code[at + SRC3] = o.src.int ? 1 : 0;
          this.sampled.add(o.texture);
          break;
        }

        case PbjOp.if: {
          const o = op as PbjIf;
          code[at + KIND] = JUMP_UNLESS;
          put(SRC, this.offsets(o.src));
          open.push({ at, otherwise: -1 });
          break;
        }

        case PbjOp.else: {
          const branch = open[open.length - 1];
          code[at + KIND] = JUMP;
          // A false condition goes past the else.
          code[branch.at + AUX] = n + 1;
          branch.otherwise = at;
          break;
        }

        case PbjOp.endIf: {
          const branch = open.pop() as { at: number; otherwise: number };
          code[at + KIND] = NOTHING;
          if (branch.otherwise < 0) {
            code[branch.at + AUX] = n + 1;
          } else {
            code[branch.otherwise + AUX] = n + 1;
          }

          break;
        }

        case PbjOp.select: {
          const o = op as PbjSelect;
          code[at + KIND] = o.dst.int ? SELECT_I : SELECT_F;
          code[at + LANES] = o.dst.size;
          put(DST, this.offsets(o.dst));
          put(SRC, this.offsets(o.a));
          put(SRC2, this.offsets(o.b));
          code[at + SRC3] = this.offsets(o.condition)[0];
          break;
        }

        default: {
          const o = op as PbjCompute;
          if (o.src.matrix) {
            code[at + KIND] = MATRIX | o.op;
            code[at + LANES] = o.src.matrix;
            put(SRC, this.columns(o.src));
            put(DST, o.dst.matrix ? this.columns(o.dst) : this.offsets(o.dst));
            break;
          }

          code[at + KIND] = o.op | (o.dst.int && o.src.int ? INT : 0);
          code[at + LANES] = o.dst.size;
          code[at + AUX] = o.src.size;
          put(DST, this.offsets(o.dst));
          put(SRC, this.offsets(o.src));
          // The comparisons write i0's first lanes, whatever their destination.
          const compares =
            (o.op >= PbjOp.equal && o.op <= PbjOp.lessThanEqual) ||
            o.op === PbjOp.vectorEqual ||
            o.op === PbjOp.vectorNotEqual;
          if (compares) {
            put(
              SRC3,
              [0, 1, 2, 3].map((c) => this.ints.slot(0) + c),
            );
          }
        }
      }
    }

    return code;
  }

  /**
   * Run over `width` by `height` pixels into `out`, `channels` floats a
   * pixel: `values` each input parameter's numbers by the parameter,
   * converted already (floats to float32, ints to int32), and `images`
   * each texture's image by its number; the first pixel's coordinate
   * `x0`, `y0`.
   */
  run(
    values: Map<PbjParameter, readonly number[]>,
    images: Map<number, ShaderImage>,
    width: number,
    height: number,
    out: Float32Array,
    x0 = 0,
    y0 = 0,
  ): void {
    this.f0.fill(0);
    this.i0.fill(0);
    for (const [p, v] of values) {
      this.setParameter(p, v);
    }

    this.images.length = 0;
    for (const [index, image] of images) {
      this.images[index] = image;
    }

    const { f, i, f0, i0, coord, out: lanes } = this;
    const channels = lanes.length;
    let at = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        f.set(f0);
        i.set(i0);
        if (coord.length > 0) {
          f[coord[0]] = x0 + x + 0.5;
        }

        if (coord.length > 1) {
          f[coord[1]] = y0 + y + 0.5;
        }

        this.pixel();
        for (let c = 0; c < channels; c++) {
          out[at++] = f[lanes[c]];
        }
      }
    }

    // The program lives as long as its kernel; the images, which may be large, not.
    this.images.length = 0;
  }

  private setParameter(p: PbjParameter, v: readonly number[]): void {
    const r = p.register;
    const lanes = r.int ? this.i0 : this.f0;
    if (!r.matrix) {
      for (const [k, offset] of this.offsets(r).entries()) {
        lanes[offset] = v[k] ?? 0;
      }

      return;
    }

    // A matrix's numbers by columns; a 3x3 matrix's columns leave their fourth lane 0.
    const columns = this.columns(r);
    const rows = r.matrix;
    for (let c = 0; c < rows; c++) {
      for (let k = 0; k < rows; k++) {
        lanes[columns[c] + k] = v[c * rows + k] ?? 0;
      }
    }
  }

  private pixel(): void {
    const { code, f, i } = this;
    const end = code.length;
    for (let pc = 0; pc < end; ) {
      const kind = code[pc];
      const n = code[pc + LANES];
      const d = pc + DST;
      const s = pc + SRC;
      pc += STRIDE;
      switch (kind) {
        case NOTHING:
          break;
        case JUMP:
          pc = code[pc - STRIDE + AUX] * STRIDE;
          break;
        case JUMP_UNLESS:
          if (i[code[s]] === 0) {
            pc = code[pc - STRIDE + AUX] * STRIDE;
          }

          break;
        case LOAD_F: {
          const v = this.constants[pc / STRIDE - 1];
          for (let k = 0; k < n; k++) {
            f[code[d + k]] = v;
          }

          break;
        }

        // The commonest, here rather than in floatOp.
        case PbjOp.mov:
          for (let k = 0; k < n; k++) {
            f[code[d + k]] = f[code[s + k]];
          }

          break;
        case PbjOp.add:
          for (let k = 0; k < n; k++) {
            f[code[d + k]] += f[code[s + k]];
          }

          break;
        case PbjOp.mul:
          for (let k = 0; k < n; k++) {
            f[code[d + k]] *= f[code[s + k]];
          }

          break;
        case LOAD_I:
          for (let k = 0; k < n; k++) {
            i[code[d + k]] = code[pc - STRIDE + SRC3];
          }

          break;
        case SELECT_F:
        case SELECT_I: {
          // Only exactly 1 selects the first, unlike if's any other than 0.
          const from = i[code[pc - STRIDE + SRC3]] === 1 ? s : pc - STRIDE + SRC2;
          const lanes = kind === SELECT_F ? f : i;
          for (let k = 0; k < n; k++) {
            lanes[code[d + k]] = lanes[code[from + k]];
          }

          break;
        }

        case SAMPLE_NEAREST:
        case SAMPLE_LINEAR:
          this.sample(pc - STRIDE, kind === SAMPLE_LINEAR);
          break;
        default:
          if (kind & MATRIX) {
            this.matrix(pc - STRIDE);
          } else if (kind & INT) {
            this.intOp(kind & 0xff, n, d, s, pc - STRIDE);
          } else {
            this.floatOp(kind, n, d, s, pc - STRIDE);
          }
      }
    }
  }

  private floatOp(op: number, n: number, d: number, s: number, at: number): void {
    const { code, f, i } = this;
    // add, mul and mov are pixel()'s.
    switch (op) {
      case PbjOp.sub:
        for (let k = 0; k < n; k++) {
          f[code[d + k]] -= f[code[s + k]];
        }

        return;
      case PbjOp.div:
        for (let k = 0; k < n; k++) {
          f[code[d + k]] /= f[code[s + k]];
        }

        return;
      case PbjOp.atan2:
        // adl's atan2 takes an x of -0 as 0: atan2(0, -0) is 0, not pi. NaN stays NaN.
        for (let k = 0; k < n; k++) {
          const x = f[code[s + k]];
          f[code[d + k]] = Math.atan2(f[code[d + k]], x === 0 ? 0 : x);
        }

        return;
      case PbjOp.pow:
        // As JavaScript's, unlike C's: 1 to NaN and -1 to Infinity are NaN in adl too.
        for (let k = 0; k < n; k++) {
          f[code[d + k]] **= f[code[s + k]];
        }

        return;
      case PbjOp.mod:
        for (let k = 0; k < n; k++) {
          const x = f[code[d + k]];
          const y = f[code[s + k]];
          f[code[d + k]] = x - Math.fround(y * Math.floor(Math.fround(x / y)));
        }

        return;
      case PbjOp.min:
        // As SSE's minss: the source where either is NaN.
        for (let k = 0; k < n; k++) {
          const x = f[code[d + k]];
          const y = f[code[s + k]];
          f[code[d + k]] = x < y ? x : y;
        }

        return;
      case PbjOp.max:
        for (let k = 0; k < n; k++) {
          const x = f[code[d + k]];
          const y = f[code[s + k]];
          f[code[d + k]] = x > y ? x : y;
        }

        return;
      case PbjOp.step:
        for (let k = 0; k < n; k++) {
          f[code[d + k]] = f[code[d + k]] < f[code[s + k]] ? 0 : 1;
        }

        return;
      case PbjOp.equal:
        // adl compares scalars alone: of vectors, equal is false and notEqual true.
        i[code[at + SRC3]] = n === 1 && f[code[d]] === f[code[s]] ? 1 : 0;
        return;
      case PbjOp.notEqual:
        i[code[at + SRC3]] = n === 1 && f[code[d]] === f[code[s]] ? 0 : 1;
        return;
      case PbjOp.lessThan:
        for (let k = 0; k < n; k++) {
          i[code[at + SRC3 + k]] = f[code[d + k]] < f[code[s + k]] ? 1 : 0;
        }

        return;
      case PbjOp.lessThanEqual:
        for (let k = 0; k < n; k++) {
          i[code[at + SRC3 + k]] = f[code[d + k]] <= f[code[s + k]] ? 1 : 0;
        }

        return;
      case PbjOp.vectorEqual:
        for (let k = 0; k < n; k++) {
          i[code[at + SRC3 + k]] = f[code[d + k]] === f[code[s + k]] ? 1 : 0;
        }

        return;
      case PbjOp.vectorNotEqual:
        for (let k = 0; k < n; k++) {
          i[code[at + SRC3 + k]] = f[code[d + k]] !== f[code[s + k]] ? 1 : 0;
        }

        return;
      case PbjOp.dot: {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          sum = Math.fround(sum + Math.fround(f[code[d + k]] * f[code[s + k]]));
        }

        f[code[d]] = sum;
        return;
      }

      case PbjOp.distance: {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          const v = Math.fround(f[code[d + k]] - f[code[s + k]]);
          sum = Math.fround(sum + Math.fround(v * v));
        }

        f[code[d]] = Math.sqrt(sum);
        return;
      }

      case PbjOp.length: {
        let sum = 0;
        for (let k = 0; k < code[at + AUX]; k++) {
          const v = f[code[s + k]];
          sum = Math.fround(sum + Math.fround(v * v));
        }

        f[code[d]] = Math.sqrt(sum);
        return;
      }

      case PbjOp.normalize: {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          const v = f[code[s + k]];
          sum = Math.fround(sum + Math.fround(v * v));
        }

        const length = Math.fround(Math.sqrt(sum));
        for (let k = 0; k < n; k++) {
          f[code[d + k]] = f[code[s + k]] / length;
        }

        return;
      }

      case PbjOp.cross: {
        const [x0, y0, z0] = [f[code[d]], f[code[d + 1]], f[code[d + 2]]];
        const [x1, y1, z1] = [f[code[s]], f[code[s + 1]], f[code[s + 2]]];
        const p = Math.fround;
        f[code[d]] = p(y0 * z1) - p(z0 * y1);
        f[code[d + 1]] = p(z0 * x1) - p(x0 * z1);
        f[code[d + 2]] = p(x0 * y1) - p(y0 * x1);
        return;
      }

      case PbjOp.floatToInt:
        for (let k = 0; k < n; k++) {
          i[code[d + k]] = toInt(f[code[s + k]]);
        }

        return;
      case PbjOp.intToFloat:
        for (let k = 0; k < n; k++) {
          f[code[d + k]] = i[code[s + k]];
        }

        return;
      case PbjOp.floatToBool:
        // The float's bits, as they are.
        for (let k = 0; k < n; k++) {
          bitsF[0] = f[code[s + k]];
          i[code[d + k]] = bitsI[0];
        }

        return;
      case PbjOp.boolToFloat:
      case PbjOp.boolToInt:
        // The int 1 or 0, its bits taken as a float's.
        for (let k = 0; k < n; k++) {
          bitsI[0] = i[code[s + k]] === 0 ? 0 : 1;
          f[code[d + k]] = bitsF[0];
        }

        return;
      case PbjOp.matMatMul:
      case PbjOp.matVecMul:
      case PbjOp.vecMatMul:
        // adl takes them on registers that are no matrices; what it does then is not known.
        return;
      default:
        this.mathOp(op, n, d, s);
    }
  }

  /** The functions of one argument. */
  private mathOp(op: number, n: number, d: number, s: number): void {
    const { code, f } = this;
    for (let k = 0; k < n; k++) {
      const x = f[code[s + k]];
      let y: number;
      switch (op) {
        case PbjOp.rcp:
          y = 1 / x;
          break;
        case PbjOp.sin:
          y = Math.sin(x);
          break;
        case PbjOp.cos:
          y = Math.cos(x);
          break;
        case PbjOp.tan:
          y = Math.tan(x);
          break;
        case PbjOp.asin:
          y = Math.asin(x);
          break;
        case PbjOp.acos:
          y = Math.acos(x);
          break;
        case PbjOp.atan:
          y = Math.atan(x);
          break;
        case PbjOp.exp:
          y = Math.exp(x);
          break;
        case PbjOp.exp2:
          y = 2 ** x;
          break;
        case PbjOp.log:
          y = Math.log(x);
          break;
        case PbjOp.log2:
          y = Math.log2(x);
          break;
        case PbjOp.sqrt:
          y = Math.sqrt(x);
          break;
        case PbjOp.rsqrt:
          y = 1 / Math.fround(Math.sqrt(x));
          break;
        case PbjOp.abs:
          y = Math.abs(x);
          break;
        case PbjOp.sign:
          // 0 for NaN, as adl has it.
          y = x > 0 ? 1 : x < 0 ? -1 : 0;
          break;
        case PbjOp.floor:
          y = Math.floor(x);
          break;
        case PbjOp.ceil:
          y = Math.ceil(x);
          break;
        default:
          // fract
          y = x - Math.floor(x);
      }

      f[code[d + k]] = y;
    }
  }

  private intOp(op: number, n: number, d: number, s: number, at: number): void {
    const { code, i } = this;
    switch (op) {
      case PbjOp.add:
        for (let k = 0; k < n; k++) {
          i[code[d + k]] += i[code[s + k]];
        }

        return;
      case PbjOp.sub:
        for (let k = 0; k < n; k++) {
          i[code[d + k]] -= i[code[s + k]];
        }

        return;
      case PbjOp.mul:
        for (let k = 0; k < n; k++) {
          i[code[d + k]] = Math.imul(i[code[d + k]], i[code[s + k]]);
        }

        return;
      case PbjOp.div:
        // Flash crashes dividing by 0; 0 here.
        for (let k = 0; k < n; k++) {
          const y = i[code[s + k]];
          i[code[d + k]] = y === 0 ? 0 : (i[code[d + k]] / y) | 0;
        }

        return;
      case PbjOp.mov:
      case PbjOp.intToBool:
        for (let k = 0; k < n; k++) {
          i[code[d + k]] = i[code[s + k]];
        }

        return;
      case PbjOp.equal:
        i[code[at + SRC3]] = n === 1 && i[code[d]] === i[code[s]] ? 1 : 0;
        return;
      case PbjOp.notEqual:
        i[code[at + SRC3]] = n === 1 && i[code[d]] === i[code[s]] ? 0 : 1;
        return;
      case PbjOp.lessThan:
        for (let k = 0; k < n; k++) {
          i[code[at + SRC3 + k]] = i[code[d + k]] < i[code[s + k]] ? 1 : 0;
        }

        return;
      case PbjOp.lessThanEqual:
        for (let k = 0; k < n; k++) {
          i[code[at + SRC3 + k]] = i[code[d + k]] <= i[code[s + k]] ? 1 : 0;
        }

        return;
      case PbjOp.vectorEqual:
        for (let k = 0; k < n; k++) {
          i[code[at + SRC3 + k]] = i[code[d + k]] === i[code[s + k]] ? 1 : 0;
        }

        return;
      case PbjOp.vectorNotEqual:
        for (let k = 0; k < n; k++) {
          i[code[at + SRC3 + k]] = i[code[d + k]] !== i[code[s + k]] ? 1 : 0;
        }

        return;
      // The logical operations are bitwise, as adl does them.
      case PbjOp.logicalNot:
        i[code[d]] = ~i[code[s]];
        return;
      case PbjOp.logicalAnd:
        i[code[d]] &= i[code[s]];
        return;
      case PbjOp.logicalOr:
        i[code[d]] |= i[code[s]];
        return;
      case PbjOp.logicalXor:
        i[code[d]] ^= i[code[s]];
        return;
      case PbjOp.any: {
        let v = 0;
        for (let k = 0; k < n; k++) {
          v |= i[code[s + k]];
        }

        i[code[d]] = v;
        return;
      }

      case PbjOp.all: {
        let v = -1;
        for (let k = 0; k < n; k++) {
          v &= i[code[s + k]];
        }

        i[code[d]] = v;
        return;
      }
    }
  }

  /** An operation on matrices, each column at its offset; a 2x2 matrix's columns are two lanes of one register. */
  private matrix(at: number): void {
    const { code, f } = this;
    const op = code[at] & 0xff;
    const n = code[at + LANES];
    const d = at + DST;
    const s = at + SRC;
    const scratch = this.scratch;
    switch (op) {
      case PbjOp.matMatMul: {
        for (let c = 0; c < n; c++) {
          const column = code[s + c];
          for (let r = 0; r < n; r++) {
            let sum = 0;
            for (let k = 0; k < n; k++) {
              sum = Math.fround(sum + Math.fround(f[code[d + k] + r] * f[column + k]));
            }

            scratch[c * n + r] = sum;
          }
        }

        for (let c = 0; c < n; c++) {
          for (let r = 0; r < n; r++) {
            f[code[d + c] + r] = scratch[c * n + r];
          }
        }

        return;
      }

      case PbjOp.matVecMul:
      case PbjOp.vecMatMul: {
        for (let k = 0; k < n; k++) {
          scratch[k] = f[code[d + k]];
        }

        for (let k = 0; k < n; k++) {
          let sum = 0;
          for (let j = 0; j < n; j++) {
            const m = op === PbjOp.matVecMul ? f[code[s + j] + k] : f[code[s + k] + j];
            sum = Math.fround(sum + Math.fround(m * scratch[j]));
          }

          f[code[d + k]] = sum;
        }

        return;
      }

      default: {
        // add, sub, mul and mov, element by element.
        for (let c = 0; c < n; c++) {
          for (let r = 0; r < n; r++) {
            const o = code[d + c] + r;
            const x = f[code[s + c] + r];
            switch (op) {
              case PbjOp.add:
                f[o] += x;
                break;
              case PbjOp.sub:
                f[o] -= x;
                break;
              case PbjOp.mul:
                f[o] *= x;
                break;
              default:
                f[o] = x;
            }
          }
        }
      }
    }
  }

  private sample(at: number, linear: boolean): void {
    const { code, f, i } = this;
    const n = code[at + LANES];
    const lanes = code[at + SRC3] ? i : f;
    const x = lanes[code[at + SRC]];
    const y = lanes[code[at + SRC + 1]];
    const image = this.images[code[at + AUX]];
    const d = at + DST;
    if (!image) {
      return;
    }

    if (image.pixels) {
      const p = linear ? sampleBytesLinear(image, x, y) : sampleBytesNearest(image, x, y);
      for (let k = 0; k < n; k++) {
        // r, g, b, a: ARGB's bytes from the third down, then the top.
        const shift = k === 3 ? 24 : 16 - k * 8;
        f[code[d + k]] = ((p >>> shift) & 0xff) * BYTE;
      }

      return;
    }

    const floats = image.floats as Float32Array;
    const channels = image.channels;
    for (let k = 0; k < n; k++) {
      f[code[d + k]] =
        k >= channels
          ? 0
          : linear
            ? sampleFloatLinear(image, floats, x, y, k)
            : floats[
                (clampIndex(Math.floor(y), image.height) * image.width +
                  clampIndex(Math.floor(x), image.width)) *
                  channels +
                  k
              ];
    }
  }
}

/** A float as a bitmap's byte: clamped, NaN as 0, then rounded to the nearest, a half to the even. */
export function outputByte(v: number): number {
  const c = v > 0 ? (v < 1 ? v : 1) : 0;
  return nearest(Math.fround(c * 255));
}

/**
 * BitmapData.applyFilter with a ShaderFilter, as adl runs it: the kernel's
 * first input is the whole source, transparent past its edges, and each
 * pixel's coordinate is the destination's, moved back by the left and top
 * extensions, whatever the rect and point; what it writes is as large as
 * the source grown by the extensions, from the point less twice the
 * rect's corner and the left and top extensions, clipped to the
 * destination (the shader-filters case's probes). Premultiplied, each
 * colour at most its alpha; an opaque destination stays opaque.
 */
export function shaderFilter(
  dest: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  extensions: readonly number[],
  use: ShaderUse,
  program: PixelBender,
): void {
  const [left, top, right, bottom] = extensions;
  const fromX = dx - 2 * rect.x - left;
  const fromY = dy - 2 * rect.y - top;
  const x0 = Math.max(0, fromX);
  const y0 = Math.max(0, fromY);
  const x1 = Math.min(dest.width, fromX + source.width + left + right);
  const y1 = Math.min(dest.height, fromY + source.height + top + bottom);
  if (x1 <= x0 || y1 <= y0) {
    return;
  }

  const images = new Map(use.images);
  const first = use.kernel.inputs[0];
  images.set(first.index, {
    width: source.width,
    height: source.height,
    pixels: source.readable,
    channels: first.channels,
    clear: true,
  });
  const width = x1 - x0;
  const height = y1 - y0;
  const channels = program.channels;
  const out = new Float32Array(width * height * channels);
  program.run(use.values, images, width, height, out, x0 - left, y0 - top);
  const pixels = dest.pixels;
  for (let y = 0, at = 0; y < height; y++) {
    for (let x = 0; x < width; x++, at += channels) {
      const a = outputByte(out[at + 3]);
      const r = Math.min(a, outputByte(out[at]));
      const g = Math.min(a, outputByte(out[at + 1]));
      const b = Math.min(a, outputByte(out[at + 2]));
      pixels[(y0 + y) * dest.width + x0 + x] =
        (((dest.transparent ? a : 255) << 24) | (r << 16) | (g << 8) | b) >>> 0;
    }
  }

  dest.changed();
}

/** A coordinate's pixel, clamped to the edges, NaN to the first. */
function clampIndex(v: number, size: number): number {
  if (!(v > 0)) {
    return 0;
  }

  return v >= size ? size - 1 : v;
}

/** A pixel of a clear image, 0 past its edges, as a pixel at (x, y) is, NaN as 0. */
function clearPixel(image: ShaderImage, x: number, y: number): number {
  const i = Number.isNaN(x) ? 0 : x;
  const j = Number.isNaN(y) ? 0 : y;
  return i >= 0 && i < image.width && j >= 0 && j < image.height
    ? (image.pixels as Uint32Array)[j * image.width + i]
    : 0;
}

function sampleBytesNearest(image: ShaderImage, x: number, y: number): number {
  if (image.clear) {
    return clearPixel(image, Math.floor(x), Math.floor(y));
  }

  const pixels = image.pixels as Uint32Array;
  return pixels[
    clampIndex(Math.floor(y), image.height) * image.width + clampIndex(Math.floor(x), image.width)
  ];
}

/**
 * Bilinear as adl filters a BitmapData: each axis' weight in 256ths,
 * rounded, the row first, then the column, each step's byte cut down.
 */
function sampleBytesLinear(image: ShaderImage, x: number, y: number): number {
  const pixels = image.pixels as Uint32Array;
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const wx = Math.round((fx - x0) * 256) || 0;
  const wy = Math.round((fy - y0) * 256) || 0;
  const w = image.width;
  const h = image.height;
  let p00: number;
  let p10: number;
  let p01: number;
  let p11: number;
  if (image.clear) {
    p00 = clearPixel(image, x0, y0);
    p10 = clearPixel(image, x0 + 1, y0);
    p01 = clearPixel(image, x0, y0 + 1);
    p11 = clearPixel(image, x0 + 1, y0 + 1);
  } else {
    const left = clampIndex(x0, w);
    const right = clampIndex(x0 + 1, w);
    const top = clampIndex(y0, h) * w;
    const bottom = clampIndex(y0 + 1, h) * w;
    p00 = pixels[top + left];
    p10 = pixels[top + right];
    p01 = pixels[bottom + left];
    p11 = pixels[bottom + right];
  }

  let out = 0;
  for (let shift = 0; shift < 32; shift += 8) {
    const row0 = (((p00 >>> shift) & 0xff) * (256 - wx) + ((p10 >>> shift) & 0xff) * wx) >> 8;
    const row1 = (((p01 >>> shift) & 0xff) * (256 - wx) + ((p11 >>> shift) & 0xff) * wx) >> 8;
    out |= ((row0 * (256 - wy) + row1 * wy) >> 8) << shift;
  }

  return out >>> 0;
}

function sampleFloatLinear(
  image: ShaderImage,
  floats: Float32Array,
  x: number,
  y: number,
  k: number,
): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  // Weights in 256ths, as for a BitmapData.
  const tx = (Math.round((fx - x0) * 256) || 0) / 256;
  const ty = (Math.round((fy - y0) * 256) || 0) / 256;
  const w = image.width;
  const c = image.channels;
  const left = clampIndex(x0, w) * c + k;
  const right = clampIndex(x0 + 1, w) * c + k;
  const top = clampIndex(y0, image.height) * w * c;
  const bottom = clampIndex(y0 + 1, image.height) * w * c;
  const row0 = floats[top + left] * (1 - tx) + floats[top + right] * tx;
  const row1 = floats[bottom + left] * (1 - tx) + floats[bottom + right] * tx;
  return row0 * (1 - ty) + row1 * ty;
}
