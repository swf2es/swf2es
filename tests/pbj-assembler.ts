// A small Pixel Bender bytecode (PBJ) assembler for tests: the kernel's
// header, parameters, inputs and metadata, then its operations, each with
// registers written as the Pixel Bender Toolkit disassembles them.
//
//   const kernel = new PbjAssembler()
//     .version(1).name("fill")
//     .param("out", "float4", "f0.rgba", "dst")
//     .ld("f0.rgba", 1)
//     .bytes();
//
// A register is `f` (float) or `i` (int), its number, and its channels: a
// destination's are a write mask (`f0.rb`), a source's a swizzle
// (`f1.gggr`), as many as the operation's size. A matrix is `f4.m3`, the
// 3x3 matrix whose columns start at f4.

const TYPES: Record<string, number> = {
  float: 0x1,
  float2: 0x2,
  float3: 0x3,
  float4: 0x4,
  matrix2x2: 0x5,
  matrix3x3: 0x6,
  matrix4x4: 0x7,
  int: 0x8,
  int2: 0x9,
  int3: 0xa,
  int4: 0xb,
  string: 0xc,
  bool: 0xd,
  bool2: 0xe,
  bool3: 0xf,
  bool4: 0x10,
};

/** The opcodes of the operations of one destination and one source. */
export const OPS: Record<string, number> = {
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
  ftoi: 0x1e,
  itof: 0x1f,
  matmatmul: 0x20,
  vecmatmul: 0x21,
  matvecmul: 0x22,
  normalize: 0x23,
  length: 0x24,
  distance: 0x25,
  dot: 0x26,
  cross: 0x27,
  equal: 0x28,
  notequal: 0x29,
  lessthan: 0x2a,
  lessthanequal: 0x2b,
  logicalnot: 0x2c,
  logicaland: 0x2d,
  logicalor: 0x2e,
  logicalxor: 0x2f,
  ftob: 0x37,
  btof: 0x38,
  itob: 0x39,
  btoi: 0x3a,
  vectorequal: 0x3b,
  vectornotequal: 0x3c,
  any: 0x3d,
  all: 0x3e,
};

const CHANNELS = "rgba";

interface Register {
  index: number;
  int: boolean;
  channels: number[];
  /** 2, 3 or 4 for a matrix, 0 for channels. */
  matrix: number;
}

function register(text: string): Register {
  const m = /^([fi])(\d+)(?:\.(m[234]|[rgba]{1,4}))?$/.exec(text);
  if (!m) {
    throw new Error(`not a register: ${text}`);
  }

  const index = Number(m[2]);
  const int = m[1] === "i";
  const part = m[3] ?? "rgba";
  if (part.startsWith("m")) {
    return { index, int, channels: [], matrix: Number(part[1]) };
  }

  return { index, int, channels: [...part].map((c) => CHANNELS.indexOf(c)), matrix: 0 };
}

export class PbjAssembler {
  private readonly out: number[] = [];

  private u8(...values: number[]): this {
    for (const v of values) {
      this.out.push(v & 0xff);
    }

    return this;
  }

  private u16(v: number): this {
    return this.u8(v, v >> 8);
  }

  private u24(v: number): this {
    return this.u8(v, v >> 8, v >> 16);
  }

  private i32(v: number): this {
    return this.u8(v, v >> 8, v >> 16, v >> 24);
  }

  /** A float as PBJ stores one: big-endian, unlike every other number in it. */
  private f32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, false);
    return this.u8(...b);
  }

  private cstring(s: string): this {
    return this.u8(...new TextEncoder().encode(s), 0);
  }

  private reg16(r: Register): number {
    return r.index | (r.int ? 0x8000 : 0);
  }

  private writeMask(r: Register): number {
    let mask = 0;
    for (const c of r.channels) {
      mask |= 8 >> c;
    }

    return mask;
  }

  private source(r: Register): number {
    let swizzle = 0;
    for (const [i, c] of r.channels.entries()) {
      swizzle |= c << (6 - i * 2);
    }

    return this.reg16(r) | (swizzle << 16);
  }

  /** Bytes as they are, for what the methods cannot write. */
  raw(...bytes: number[]): this {
    return this.u8(...bytes);
  }

  version(v: number): this {
    return this.u8(0xa5).i32(v);
  }

  name(s: string): this {
    const bytes = new TextEncoder().encode(s);
    return this.u8(0xa4)
      .u16(bytes.length)
      .u8(...bytes);
  }

  /** Metadata of the kernel before any parameter, else of the parameter before it. */
  meta(key: string, type: string, value: number | number[] | string, second = false): this {
    const code = TYPES[type];
    this.u8(second ? 0xa2 : 0xa0, code).cstring(key);
    if (typeof value === "string") {
      return this.cstring(value);
    }

    for (const v of typeof value === "number" ? [value] : value) {
      if (code <= 0x7) {
        this.f32(v);
      } else {
        this.u16(v);
      }
    }

    return this;
  }

  param(qualifier: "in" | "out", type: string, reg: string, name: string): this {
    const r = register(reg);
    const mask = r.matrix || this.writeMask(r);
    return this.u8(0xa1, qualifier === "in" ? 1 : 2, TYPES[type])
      .u16(this.reg16(r))
      .u8(mask)
      .cstring(name);
  }

  input(index: number, channels: number, name: string): this {
    return this.u8(0xa3, index, channels).cstring(name);
  }

  /** An operation of a destination and a source, by name or opcode. */
  op(op: string | number, dst: string, src: string): this {
    const d = register(dst);
    const s = register(src);
    const code = typeof op === "number" ? op : OPS[op];
    if (s.matrix) {
      const bits = s.matrix - 1;
      const mask = d.matrix ? 0 : this.writeMask(d);
      return this.u8(code)
        .u16(this.reg16(d))
        .u8((mask << 4) | (bits << 2))
        .u24(this.reg16(s))
        .u8(0);
    }

    return this.u8(code)
      .u16(this.reg16(d))
      .u8((this.writeMask(d) << 4) | (s.channels.length - 1))
      .u24(this.source(s))
      .u8(0);
  }

  /** Loads a constant: a float into a float register, an int into an int one. */
  ld(dst: string, value: number): this {
    const d = register(dst);
    this.u8(0x32)
      .u16(this.reg16(d))
      .u8(this.writeMask(d) << 4);
    return d.int ? this.i32(value) : this.f32(value);
  }

  sample(linear: boolean, dst: string, coord: string, texture: number): this {
    const d = register(dst);
    const c = register(coord);
    return this.u8(linear ? 0x31 : 0x30)
      .u16(this.reg16(d))
      .u8((this.writeMask(d) << 4) | (c.channels.length - 1))
      .u24(this.source(c))
      .u8(texture);
  }

  if(condition: string): this {
    return this.u8(0x34, 0, 0, 0)
      .u24(this.source(register(condition)))
      .u8(0);
  }

  else(): this {
    return this.u8(0x35, 0, 0, 0, 0, 0, 0, 0);
  }

  endif(): this {
    return this.u8(0x36, 0, 0, 0, 0, 0, 0, 0);
  }

  select(dst: string, condition: string, a: string, b: string): this {
    const d = register(dst);
    return this.u8(0x33)
      .u16(this.reg16(d))
      .u8(this.writeMask(d) << 4)
      .u24(this.source(register(condition)))
      .u8(0)
      .u24(this.source(register(a)))
      .u8(0)
      .u24(this.source(register(b)))
      .u8(0);
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.out);
  }
}
