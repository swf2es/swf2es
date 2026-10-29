// Pixel Bender bytecode (PBJ), as flash.display.Shader takes it: the
// kernel's metadata, parameters and image inputs, then its operations. The
// layout is Ruffle's (https://github.com/ruffle-rs/ruffle)
// render/pixel_bender/src/parser.rs, itself after pbjas and Haxe's
// format.pbj: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and
// Ruffle contributors. What Flash refuses, and with which error, is
// adl's: bytes that end inside an opcode are EOFError 2030, and anything
// else it will not run, ArgumentError 2004, kernels Ruffle accepts among
// them (each operation's register kinds and sizes, PBJ_RULES).
import { utf8 } from "./display.js";

/** The parameter and metadata types, by their PBJ code, as ShaderParameterType names them. */
export const PBJ_TYPES = [
  null,
  "float",
  "float2",
  "float3",
  "float4",
  "matrix2x2",
  "matrix3x3",
  "matrix4x4",
  "int",
  "int2",
  "int3",
  "int4",
  "string",
  "bool",
  "bool2",
  "bool3",
  "bool4",
] as const;

export const PBJ_STRING = 0xc;

/** How many numbers a value of each type holds, by code; 0 for a string. */
export const PBJ_TYPE_SIZES = [0, 1, 2, 3, 4, 4, 9, 16, 1, 2, 3, 4, 0, 1, 2, 3, 4];

/** Whether a type's numbers are floats, by code. */
export function pbjFloatType(type: number): boolean {
  return type >= 0x1 && type <= 0x7;
}

export const PbjOp = {
  nop: 0x00,
  add: 0x01,
  sub: 0x02,
  mul: 0x03,
  rcp: 0x04,
  div: 0x05,
  atan2: 0x06,
  pow: 0x07,
  mod: 0x08,
  min: 0x09,
  max: 0x0a,
  step: 0x0b,
  sin: 0x0c,
  cos: 0x0d,
  tan: 0x0e,
  asin: 0x0f,
  acos: 0x10,
  atan: 0x11,
  exp: 0x12,
  exp2: 0x13,
  log: 0x14,
  log2: 0x15,
  sqrt: 0x16,
  rsqrt: 0x17,
  abs: 0x18,
  sign: 0x19,
  floor: 0x1a,
  ceil: 0x1b,
  fract: 0x1c,
  mov: 0x1d,
  floatToInt: 0x1e,
  intToFloat: 0x1f,
  matMatMul: 0x20,
  vecMatMul: 0x21,
  matVecMul: 0x22,
  normalize: 0x23,
  length: 0x24,
  distance: 0x25,
  dot: 0x26,
  cross: 0x27,
  equal: 0x28,
  notEqual: 0x29,
  lessThan: 0x2a,
  lessThanEqual: 0x2b,
  logicalNot: 0x2c,
  logicalAnd: 0x2d,
  logicalOr: 0x2e,
  logicalXor: 0x2f,
  sampleNearest: 0x30,
  sampleLinear: 0x31,
  load: 0x32,
  select: 0x33,
  if: 0x34,
  else: 0x35,
  endIf: 0x36,
  floatToBool: 0x37,
  boolToFloat: 0x38,
  intToBool: 0x39,
  boolToInt: 0x3a,
  vectorEqual: 0x3b,
  vectorNotEqual: 0x3c,
  any: 0x3d,
  all: 0x3e,
  kernelMetadata: 0xa0,
  parameter: 0xa1,
  parameterMetadata: 0xa2,
  texture: 0xa3,
  name: 0xa4,
  version: 0xa5,
} as const;

/** A register an operation names. */
export interface PbjRegister {
  index: number;
  int: boolean;
  /**
   * A destination's channels, 0 to 3 for r to a, those its mask writes in
   * order; a source's swizzle, four channels, of which `size` are its own:
   * an operation reads as many as it writes, the rest by the swizzle's
   * remaining bits, as Flash does.
   */
  channels: number[];
  /** A source's own channels; a destination's channel count. */
  size: number;
  /** 2, 3 or 4 for a matrix of that size, its columns from `index` on; 0 otherwise. */
  matrix: number;
}

/** An operation of a destination and a source, or of matrices. */
export interface PbjCompute {
  op: number;
  dst: PbjRegister;
  src: PbjRegister;
}

export interface PbjLoad {
  op: typeof PbjOp.load;
  dst: PbjRegister;
  /** A float, or an int as the 16 bits Flash keeps. */
  value: number;
}

export interface PbjSample {
  op: typeof PbjOp.sampleNearest | typeof PbjOp.sampleLinear;
  dst: PbjRegister;
  src: PbjRegister;
  texture: number;
}

export interface PbjIf {
  op: typeof PbjOp.if;
  src: PbjRegister;
}

export interface PbjSelect {
  op: typeof PbjOp.select;
  dst: PbjRegister;
  condition: PbjRegister;
  a: PbjRegister;
  b: PbjRegister;
}

export type PbjOperation =
  | PbjCompute
  | PbjLoad
  | PbjSample
  | PbjIf
  | { op: typeof PbjOp.else | typeof PbjOp.endIf }
  | PbjSelect;

/** A metadata value: a string, or its numbers, ints as the unsigned 16 bits PBJ stores. */
export interface PbjMetadata {
  key: string;
  type: number;
  value: string | number[];
}

export interface PbjParameter {
  name: string;
  /** The type's code, PBJ_TYPES; one Flash does not know is kept, as it keeps it. */
  type: number;
  output: boolean;
  register: PbjRegister;
  /** Its metadata, from the second metadata opcode alone: Flash drops the first's here. */
  metadata: PbjMetadata[];
}

export interface PbjInput {
  name: string;
  /** The texture's number, which sampling names and ShaderInput.index gives. */
  index: number;
  channels: number;
}

export interface PbjKernel {
  /** The kernel's name, or null where it has none: ShaderData then has no `name`. */
  name: string | null;
  /** Every first-opcode metadata, an int or a string, which Flash gives the kernel wherever it stands. */
  metadata: PbjMetadata[];
  parameters: PbjParameter[];
  inputs: PbjInput[];
  operations: PbjOperation[];
}

/** Why Flash refuses a kernel: EOFError 2030 for bytes that end too soon, ArgumentError 2004 for anything else. */
export class PbjError extends Error {
  constructor(readonly errorID: 2004 | 2030) {
    super(errorID === 2030 ? "End of file was encountered." : "One of the parameters is invalid.");
  }
}

const F = 1;
const I = 2;

/**
 * Which register kinds and sizes adl takes for each operation of one
 * destination and one source, by opcode: `kinds` lists the destination's
 * and the source's kinds as pairs, and `sizes` how the destination's
 * channel count and the source's size may go together.
 */
export interface PbjRule {
  kinds: number[];
  sizes: "same" | "any" | "scalar" | "vector" | "length" | "cross";
}

const FF = [F, F];
const FF_II = [F, F, I, I];
const SAME_FLOAT: PbjRule = { kinds: FF, sizes: "same" };
const SAME_EITHER: PbjRule = { kinds: FF_II, sizes: "same" };

export const PBJ_RULES = new Map<number, PbjRule>([
  [PbjOp.add, SAME_EITHER],
  [PbjOp.sub, SAME_EITHER],
  [PbjOp.mul, SAME_EITHER],
  [PbjOp.div, SAME_EITHER],
  [PbjOp.mov, SAME_EITHER],
  [PbjOp.equal, SAME_EITHER],
  [PbjOp.notEqual, SAME_EITHER],
  [PbjOp.lessThan, SAME_EITHER],
  [PbjOp.lessThanEqual, SAME_EITHER],
  [PbjOp.matMatMul, SAME_FLOAT],
  [PbjOp.vecMatMul, { kinds: [F, F, F, I, I, F, I, I], sizes: "scalar" }],
  [PbjOp.matVecMul, { kinds: [F, F, F, I, I, F, I, I], sizes: "scalar" }],
  [PbjOp.normalize, { kinds: FF, sizes: "vector" }],
  [PbjOp.length, { kinds: FF, sizes: "length" }],
  [PbjOp.distance, { kinds: FF, sizes: "vector" }],
  [PbjOp.cross, { kinds: FF, sizes: "cross" }],
  [PbjOp.floatToInt, { kinds: [I, F], sizes: "same" }],
  [PbjOp.intToFloat, { kinds: [F, I], sizes: "same" }],
  [PbjOp.logicalNot, { kinds: [I, I], sizes: "scalar" }],
  [PbjOp.logicalAnd, { kinds: [I, I], sizes: "scalar" }],
  [PbjOp.logicalOr, { kinds: [I, I], sizes: "scalar" }],
  [PbjOp.logicalXor, { kinds: [I, I], sizes: "scalar" }],
  [PbjOp.floatToBool, { kinds: [I, F], sizes: "any" }],
  [PbjOp.boolToFloat, { kinds: [F, I], sizes: "any" }],
  [PbjOp.intToBool, { kinds: [I, I], sizes: "any" }],
  [PbjOp.boolToInt, { kinds: [F, I], sizes: "any" }],
  [PbjOp.vectorEqual, { kinds: FF_II, sizes: "any" }],
  [PbjOp.vectorNotEqual, { kinds: FF_II, sizes: "any" }],
  [PbjOp.any, { kinds: [I, I], sizes: "any" }],
  [PbjOp.all, { kinds: [I, I], sizes: "any" }],
]);
for (let op: number = PbjOp.rcp; op <= PbjOp.fract; op++) {
  if (op !== PbjOp.div) {
    PBJ_RULES.set(op, SAME_FLOAT);
  }
}

PBJ_RULES.set(PbjOp.dot, SAME_FLOAT);

/** The operations adl takes on matrices, each column as its registers hold it. */
const MATRIX_OPS: readonly number[] = [
  PbjOp.add,
  PbjOp.sub,
  PbjOp.mul,
  PbjOp.mov,
  PbjOp.matMatMul,
  PbjOp.matVecMul,
  PbjOp.vecMatMul,
];

function sizesFit(rule: PbjRule, dst: number, src: number): boolean {
  switch (rule.sizes) {
    case "same":
      return dst === src;
    case "any":
      return true;
    case "scalar":
      return dst === 1 && src === 1;
    case "vector":
      return dst === src && src >= 2;
    case "length":
      return dst === 1 && src >= 2;
    case "cross":
      return dst === 3 && src === 3;
  }
}

function kindsFit(rule: PbjRule, dst: PbjRegister, src: PbjRegister): boolean {
  const d = dst.int ? I : F;
  const s = src.int ? I : F;
  for (let i = 0; i < rule.kinds.length; i += 2) {
    if (rule.kinds[i] === d && rule.kinds[i + 1] === s) {
      return true;
    }
  }

  return false;
}

class Reader {
  private at = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  private need(n: number): number {
    const at = this.at;
    if (at + n > this.bytes.length) {
      throw new PbjError(2030);
    }

    this.at += n;
    return at;
  }

  u8(): number {
    return this.bytes[this.need(1)];
  }

  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }

  u24(): number {
    const at = this.need(3);
    return this.bytes[at] | (this.bytes[at + 1] << 8) | (this.bytes[at + 2] << 16);
  }

  i32(): number {
    return this.view.getInt32(this.need(4), true);
  }

  /** A float, big-endian, unlike every other number in PBJ. */
  f32(): number {
    return this.view.getFloat32(this.need(4), false);
  }

  skip(n: number): void {
    this.need(n);
  }

  /** A string to its terminating zero, in UTF-8. */
  cstring(): string {
    const start = this.at;
    while (this.u8() !== 0) {
      // Up to the zero.
    }

    return utf8(this.bytes.subarray(start, this.at - 1));
  }

  string(length: number): string {
    return utf8(this.bytes.subarray(this.need(length), this.at));
  }
}

/** A destination: a register of the channels its 4-bit mask writes, r first. */
function destination(value: number, mask: number): PbjRegister {
  const channels: number[] = [];
  for (let c = 0; c < 4; c++) {
    if (mask & (8 >> c)) {
      channels.push(c);
    }
  }

  return {
    index: value & 0x7fff,
    int: (value & 0x8000) !== 0,
    channels,
    size: channels.length,
    matrix: 0,
  };
}

/** A source: its register in the low 16 bits, the swizzle's four channels in the high 8. */
function source(value: number, size: number): PbjRegister {
  const swizzle = value >>> 16;
  const channels: number[] = [];
  for (let i = 0; i < 4; i++) {
    channels.push((swizzle >> (6 - i * 2)) & 3);
  }

  return { index: value & 0x7fff, int: (value & 0x8000) !== 0, channels, size, matrix: 0 };
}

function matrix(value: number, size: number): PbjRegister {
  return {
    index: value & 0x7fff,
    int: (value & 0x8000) !== 0,
    channels: [],
    size: 1,
    matrix: size,
  };
}

function metadataValue(r: Reader, type: number): string | number[] {
  if (type === PBJ_STRING) {
    return r.cstring();
  }

  const values: number[] = [];
  for (let i = 0; i < PBJ_TYPE_SIZES[type]; i++) {
    values.push(pbjFloatType(type) ? r.f32() : r.u16());
  }

  return values;
}

/**
 * The kernel `bytes` hold, or PbjError with the error Flash refuses it
 * with. Every byte is read: PBJ has no length, so it ends with the bytes.
 */
export function readPbj(bytes: Uint8Array): PbjKernel {
  const r = new Reader(bytes);
  const kernel: PbjKernel = {
    name: null,
    metadata: [],
    parameters: [],
    inputs: [],
    operations: [],
  };
  /** The parameter the second metadata opcode adds to: the last one, but for an input after it. */
  let owner: PbjParameter | null = null;
  let depth = 0;
  const elses: boolean[] = [];
  const refuse = (): never => {
    throw new PbjError(2004);
  };

  while (!r.done) {
    const op = r.u8();
    switch (op) {
      case PbjOp.version: {
        if (r.i32() !== 1) {
          refuse();
        }

        break;
      }

      case PbjOp.name: {
        kernel.name = r.string(r.u16());
        break;
      }

      case PbjOp.kernelMetadata:
      case PbjOp.parameterMetadata: {
        const type = r.u8();
        const key = r.cstring();
        if (type === 0 || type >= PBJ_TYPES.length) {
          // adl reads on past what it cannot size, to the end.
          throw new PbjError(2030);
        }

        const value = metadataValue(r, type);
        if (op === PbjOp.kernelMetadata) {
          if (type !== PBJ_STRING && type !== 0x8) {
            refuse();
          }

          kernel.metadata.push({ key, type, value });
        } else {
          owner?.metadata.push({ key, type, value });
        }

        break;
      }

      case PbjOp.parameter: {
        const qualifier = r.u8();
        const type = r.u8();
        const reg = r.u16();
        const mask = r.u8();
        const name = r.cstring();
        const output = qualifier === 2;
        if (type === PBJ_STRING || name === "name" || (output && !pbjFloatType(type))) {
          refuse();
        }

        const size = type - 0x5 + 2;
        const register = size >= 2 && size <= 4 ? matrix(reg, size) : destination(reg, mask & 0xf);
        const parameter: PbjParameter = { name, type, output, register, metadata: [] };
        if (output && register.matrix) {
          refuse();
        }

        kernel.parameters.push(parameter);
        owner = parameter;
        break;
      }

      case PbjOp.texture: {
        const index = r.u8();
        const channels = r.u8();
        kernel.inputs.push({ name: r.cstring(), index, channels });
        owner = null;
        break;
      }

      case PbjOp.nop: {
        if (r.u24() !== 0 || r.u24() !== 0) {
          refuse();
        }

        break;
      }

      case PbjOp.load: {
        const dst = destination(r.u16(), r.u8() >> 4);
        const value = dst.int ? r.i32() & 0xffff : r.f32();
        if (dst.size === 0) {
          refuse();
        }

        kernel.operations.push({ op, dst, value });
        break;
      }

      case PbjOp.sampleNearest:
      case PbjOp.sampleLinear: {
        const reg = r.u16();
        const mask = r.u8();
        const src = source(r.u24(), (mask & 3) + 1);
        const texture = r.u8();
        const dst = destination(reg, mask >> 4);
        // adl takes an int coordinate, and a texture never declared, which then has no input.
        if (dst.int || dst.size === 0) {
          refuse();
        }

        kernel.operations.push({ op, dst, src, texture });
        break;
      }

      case PbjOp.if: {
        r.skip(3);
        const src = source(r.u24(), 1);
        r.skip(1);
        if (!src.int) {
          refuse();
        }

        depth++;
        elses.push(false);
        kernel.operations.push({ op, src });
        break;
      }

      case PbjOp.else:
      case PbjOp.endIf: {
        r.skip(7);
        if (depth === 0 || (op === PbjOp.else && elses[elses.length - 1])) {
          refuse();
        }

        if (op === PbjOp.else) {
          elses[elses.length - 1] = true;
        } else {
          depth--;
          elses.pop();
        }

        kernel.operations.push({ op });
        break;
      }

      case PbjOp.select: {
        const dst = destination(r.u16(), r.u8() >> 4);
        const condition = source(r.u24(), 1);
        r.skip(1);
        const a = source(r.u24(), dst.size);
        r.skip(1);
        const b = source(r.u24(), dst.size);
        r.skip(1);
        if (!condition.int || dst.int !== a.int || a.int !== b.int || dst.size === 0) {
          refuse();
        }

        kernel.operations.push({ op, dst, condition, a, b });
        break;
      }

      default: {
        const reg = r.u16();
        const mask = r.u8();
        const value = r.u24();
        r.skip(1);
        const rule = PBJ_RULES.get(op) ?? refuse();
        const size = (mask & 3) + 1;
        const bits = (mask >> 2) & 3;
        if (bits === 0) {
          const dst = destination(reg, mask >> 4);
          const src = source(value, size);
          if (dst.size === 0 || !kindsFit(rule, dst, src) || !sizesFit(rule, dst.size, src.size)) {
            refuse();
          }

          kernel.operations.push({ op, dst, src });
          break;
        }

        // A matrix: its size in the mask, and no swizzle.
        const n = bits + 1;
        const src = matrix(value, n);
        const vector = op === PbjOp.matVecMul || op === PbjOp.vecMatMul;
        const dst = vector ? destination(reg, mask >> 4) : matrix(reg, n);
        if (
          !MATRIX_OPS.includes(op) ||
          value >>> 16 !== 0 ||
          size !== 1 ||
          src.int ||
          dst.int ||
          (vector ? dst.size !== n : mask >> 4 !== 0)
        ) {
          refuse();
        }

        kernel.operations.push({ op, dst, src });
      }
    }
  }

  if (depth !== 0 || !kernel.parameters.some((p) => p.output)) {
    refuse();
  }

  return kernel;
}
