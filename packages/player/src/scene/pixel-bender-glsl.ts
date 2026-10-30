// Pixel Bender kernels as GLSL ES 3.00, for what Flash draws with them: a
// ShaderFilter, a blend shader and a shader fill (@swf2es/render's
// kernel-shaders.ts runs them). The function made computes what the CPU
// interpreter (bitmap/pixel-bender.ts), the reference, computes, with its
// quirks measured in adl: equal and notEqual of scalars alone, a
// comparison's result in i0 whatever its destination, ftoi rounding a half
// to the even, select's first source only on exactly 1, the logical
// operations bitwise. Each operation is written a lane at a time, in the
// interpreter's order, so that a destination its source overlaps reads
// what the lanes before it wrote, as there. The transcendentals and the
// float rounding are the GPU's: close, not the same bits.
import {
  type PbjCompute,
  type PbjIf,
  type PbjKernel,
  type PbjLoad,
  PbjOp,
  type PbjParameter,
  type PbjRegister,
  type PbjSample,
  type PbjSelect,
} from "@swf2es/format";
import { OUT_COORD } from "../bitmap/pixel-bender.js";

/**
 * A kernel as GLSL: `source` declares `vec4 pbKernel(vec2 outCoord)`, the
 * output pixel at `outCoord`, its parameters' registers read from the
 * uniforms `pbFloats` and `pbInts` (kernelParameters packs them), and
 * calls `pbNearest<t>(vec2)` and `pbLinear<t>(vec2)` for each texture `t`
 * it samples, which the program it goes into defines: each a pixel's
 * premultiplied bytes times the float nearest 1/255, as the interpreter
 * samples.
 */
export interface KernelGlsl {
  source: string;
  /** The texture numbers it samples. */
  textures: number[];
  /** The float registers that hold its parameters, in `pbFloats`' order, and the int ones in `pbInts`'. */
  floatParams: number[];
  intParams: number[];
}

const LANES = "xyzw";

/** A float32 as a GLSL literal that reads back as the same float. */
function floatLiteral(v: number): string {
  const f = Math.fround(v);
  if (Number.isNaN(f)) {
    return "uintBitsToFloat(0x7fc00000u)";
  }

  if (f === Number.POSITIVE_INFINITY) {
    return "uintBitsToFloat(0x7f800000u)";
  }

  if (f === Number.NEGATIVE_INFINITY) {
    return "uintBitsToFloat(0xff800000u)";
  }

  if (Object.is(f, -0)) {
    return "-0.0";
  }

  const s = String(f);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

function intLiteral(v: number): string {
  // A literal past int's range does not compile; the least int is written as a sum.
  return v === -2147483648 ? "(-2147483647 - 1)" : String(v | 0);
}

/** Scalar helpers for the operations whose GLSL builtins differ from adl's, or are undefined where adl is not. */
const HELPERS = `int pbFtoi(float x) {
  // A half to the even, written out: roundEven is not every driver's.
  float f = floor(x);
  float d = x - f;
  float r = d > 0.5 || (d == 0.5 && mod(f, 2.0) != 0.0) ? f + 1.0 : f;
  return r >= -2147483648.0 && r < 2147483648.0 ? int(r) : (-2147483647 - 1);
}
int pbDivide(int x, int y) {
  if (y == 0) { return 0; }
  int q = abs(x) / abs(y);
  return (x < 0) != (y < 0) ? -q : q;
}
float pbSign(float x) {
  return x > 0.0 ? 1.0 : (x < 0.0 ? -1.0 : 0.0);
}
float pbAtan2(float y, float x) {
  if (x == 0.0) {
    return y == 0.0 ? y : (y > 0.0 ? 1.5707964 : -1.5707964);
  }
  return atan(y, x);
}
float pbPow(float x, float y) {
  if (y == 0.0) { return 1.0; }
  if (x > 0.0) { return exp2(y * log2(x)); }
  if (x == 0.0) { return y > 0.0 ? 0.0 : uintBitsToFloat(0x7f800000u); }
  if (y != floor(y)) { return uintBitsToFloat(0x7fc00000u); }
  float m = exp2(y * log2(-x));
  return mod(y, 2.0) == 1.0 ? -m : m;
}
`;

/** Writes a kernel's operations as GLSL statements, a lane at a time. */
class Writer {
  readonly lines: string[] = [];
  readonly floats = new Set<number>();
  readonly ints = new Set<number>();
  readonly textures = new Set<number>();
  private depth = 1;
  private temps = 0;

  emit(line: string): void {
    this.lines.push(`${"  ".repeat(this.depth)}${line}`);
  }

  open(line: string): void {
    this.emit(line);
    this.depth++;
  }

  close(line = "}"): void {
    this.depth--;
    this.emit(line);
  }

  /** A line between two blocks, at the depth of the line that opened the first. */
  between(line: string): void {
    this.depth--;
    this.emit(line);
    this.depth++;
  }

  temp(): string {
    return `t${this.temps++}`;
  }

  /** Register `index` of a kind, noted as used. */
  register(int: boolean, index: number): string {
    (int ? this.ints : this.floats).add(index);
    return `${int ? "i" : "f"}${index}`;
  }

  /** A register's lane `channel`. */
  lane(r: PbjRegister, channel: number): string {
    return `${this.register(r.int, r.index)}.${LANES[channel]}`;
  }

  /** A destination's `k`th lane written, or a source's `k`th read, by its channels. */
  at(r: PbjRegister, k: number): string {
    return this.lane(r, r.channels[k] ?? 0);
  }

  /** Lane `row` of column `column` of a matrix whose columns start at `r`: a 2x2's are two lanes of one register. */
  cell(r: PbjRegister, column: number, row: number): string {
    if (r.matrix === 2) {
      return `${this.register(r.int, r.index)}.${LANES[column * 2 + row]}`;
    }

    return `${this.register(r.int, r.index + column)}.${LANES[row]}`;
  }
}

const made = new WeakMap<PbjKernel, KernelGlsl>();

/** `kernel` as GLSL, made once a kernel. */
export function kernelGlslOf(kernel: PbjKernel): KernelGlsl {
  let glsl = made.get(kernel);
  if (!glsl) {
    glsl = kernelGlsl(kernel);
    made.set(kernel, glsl);
  }

  return glsl;
}

/** `kernel`'s operations as GLSL (KernelGlsl). */
export function kernelGlsl(kernel: PbjKernel): KernelGlsl {
  const w = new Writer();
  for (const op of kernel.operations) {
    operation(w, op);
  }

  // The parameters' registers, which start each pixel as the parameters set them.
  const floatParams = new Set<number>();
  const intParams = new Set<number>();
  for (const p of kernel.parameters) {
    if (p.output || p.name === OUT_COORD) {
      continue;
    }

    for (const index of parameterRegisters(p.register)) {
      (p.register.int ? intParams : floatParams).add(index);
      w.register(p.register.int, index);
    }
  }

  // The pixel's coordinate, set after the registers start: noted as used before they are declared.
  const coord = kernel.parameters.find((p) => !p.output && p.name === OUT_COORD);
  const coordLines: string[] = [];
  if (coord && !coord.register.int && !coord.register.matrix) {
    const r = coord.register;
    coordLines.push(`  ${w.at(r, 0)} = outCoord.x;`);
    if (r.channels.length > 1) {
      coordLines.push(`  ${w.at(r, 1)} = outCoord.y;`);
    }
  }

  const outputs = kernel.parameters.filter((p) => p.output);
  const output = outputs[outputs.length - 1]?.register;
  const result = output ? outputOf(w, output) : "vec4(0.0, 0.0, 0.0, 1.0)";
  const floats = [...floatParams].sort((a, b) => a - b);
  const ints = [...intParams].sort((a, b) => a - b);
  const declarations: string[] = [];
  for (const index of [...w.floats].sort((a, b) => a - b)) {
    const k = floats.indexOf(index);
    declarations.push(`  vec4 f${index} = ${k >= 0 ? `pbFloats[${k}]` : "vec4(0.0)"};`);
  }

  for (const index of [...w.ints].sort((a, b) => a - b)) {
    const k = ints.indexOf(index);
    declarations.push(`  ivec4 i${index} = ${k >= 0 ? `pbInts[${k}]` : "ivec4(0)"};`);
  }

  const uniforms: string[] = [];
  if (floats.length > 0) {
    uniforms.push(`uniform vec4 pbFloats[${floats.length}];`);
  }

  if (ints.length > 0) {
    uniforms.push(`uniform ivec4 pbInts[${ints.length}];`);
  }

  const source = [
    ...uniforms,
    HELPERS,
    "vec4 pbKernel(vec2 outCoord) {",
    ...declarations,
    ...coordLines,
    ...w.lines,
    `  return ${result};`,
    "}",
    "",
  ].join("\n");
  return {
    source,
    textures: [...w.textures].sort((a, b) => a - b),
    floatParams: floats,
    intParams: ints,
  };
}

/** The registers a parameter's numbers fill: a matrix's columns, or its one register. */
function parameterRegisters(r: PbjRegister): number[] {
  if (r.matrix > 2) {
    return Array.from({ length: r.matrix }, (_, c) => r.index + c);
  }

  return [r.index];
}

/**
 * The output pixel: the output register's lanes, an int one's zeros, as
 * the interpreter gives; three channels are opaque.
 */
function outputOf(w: Writer, r: PbjRegister): string {
  const lanes = r.channels.slice(0, Math.max(1, r.size || r.channels.length));
  const values = lanes.map((c) => (r.int ? "0.0" : w.lane(r, c)));
  while (values.length < 3) {
    values.push("0.0");
  }

  if (values.length < 4) {
    values.push("1.0");
  }

  return `vec4(${values.slice(0, 4).join(", ")})`;
}

function operation(w: Writer, op: PbjKernel["operations"][number]): void {
  switch (op.op) {
    case PbjOp.load: {
      const o = op as PbjLoad;
      const value = o.dst.int ? intLiteral(o.value) : floatLiteral(o.value);
      for (let k = 0; k < o.dst.size; k++) {
        w.emit(`${w.at(o.dst, k)} = ${value};`);
      }

      return;
    }

    case PbjOp.sampleNearest:
    case PbjOp.sampleLinear: {
      const o = op as PbjSample;
      w.textures.add(o.texture);
      const kind = o.op === PbjOp.sampleLinear ? "pbLinear" : "pbNearest";
      const x = w.at(o.src, 0);
      const y = w.at(o.src, 1);
      const coord = o.src.int ? `vec2(float(${x}), float(${y}))` : `vec2(${x}, ${y})`;
      const t = w.temp();
      w.open("{");
      w.emit(`vec4 ${t} = ${kind}${o.texture}(${coord});`);
      for (let k = 0; k < o.dst.size; k++) {
        w.emit(`${w.at(o.dst, k)} = ${t}.${LANES[k]};`);
      }

      w.close();
      return;
    }

    case PbjOp.if:
      w.open(`if (${w.at((op as PbjIf).src, 0)} != 0) {`);
      return;
    case PbjOp.else:
      w.between("} else {");
      return;
    case PbjOp.endIf:
      w.close();
      return;
    case PbjOp.select: {
      // Only exactly 1 selects the first, unlike if's any other than 0.
      const o = op as PbjSelect;
      const c = w.temp();
      w.open("{");
      w.emit(`bool ${c} = ${w.at(o.condition, 0)} == 1;`);
      for (let k = 0; k < o.dst.size; k++) {
        w.emit(`${w.at(o.dst, k)} = ${c} ? ${w.at(o.a, k)} : ${w.at(o.b, k)};`);
      }

      w.close();
      return;
    }

    case PbjOp.nop:
      return;
    default: {
      const o = op as PbjCompute;
      if (o.src.matrix) {
        matrixOp(w, o);
      } else if (o.dst.int && o.src.int) {
        intOp(w, o);
      } else {
        floatOp(w, o);
      }
    }
  }
}

/** The comparisons' results go to i0's first lanes, whatever their destination. */
function compareInto(w: Writer, k: number): string {
  return `${w.register(true, 0)}.${LANES[k]}`;
}

function floatOp(w: Writer, o: PbjCompute): void {
  const n = o.dst.size;
  const d = (k: number) => w.at(o.dst, k);
  const s = (k: number) => w.at(o.src, k);
  const each = (f: (d: string, s: string) => string) => {
    for (let k = 0; k < n; k++) {
      w.emit(`${d(k)} = ${f(d(k), s(k))};`);
    }
  };

  switch (o.op) {
    case PbjOp.mov:
      each((_, b) => b);
      return;
    case PbjOp.add:
      each((a, b) => `${a} + ${b}`);
      return;
    case PbjOp.sub:
      each((a, b) => `${a} - ${b}`);
      return;
    case PbjOp.mul:
      each((a, b) => `${a} * ${b}`);
      return;
    case PbjOp.div:
      each((a, b) => `${a} / ${b}`);
      return;
    case PbjOp.atan2:
      each((a, b) => `pbAtan2(${a}, ${b})`);
      return;
    case PbjOp.pow:
      each((a, b) => `pbPow(${a}, ${b})`);
      return;
    case PbjOp.mod:
      each((a, b) => `${a} - ${b} * floor(${a} / ${b})`);
      return;
    case PbjOp.min:
      // As SSE's minss: the source where either is NaN.
      each((a, b) => `${a} < ${b} ? ${a} : ${b}`);
      return;
    case PbjOp.max:
      each((a, b) => `${a} > ${b} ? ${a} : ${b}`);
      return;
    case PbjOp.step:
      each((a, b) => `${a} < ${b} ? 0.0 : 1.0`);
      return;
    case PbjOp.equal:
      // adl compares scalars alone: of vectors, equal is false and notEqual true.
      w.emit(`${compareInto(w, 0)} = ${n === 1 ? `${d(0)} == ${s(0)} ? 1 : 0` : "0"};`);
      return;
    case PbjOp.notEqual:
      w.emit(`${compareInto(w, 0)} = ${n === 1 ? `${d(0)} == ${s(0)} ? 0 : 1` : "1"};`);
      return;
    case PbjOp.lessThan:
    case PbjOp.lessThanEqual:
    case PbjOp.vectorEqual:
    case PbjOp.vectorNotEqual: {
      const test = { 42: "<", 43: "<=", 59: "==", 60: "!=" }[o.op] as string;
      for (let k = 0; k < n; k++) {
        w.emit(`${compareInto(w, k)} = ${d(k)} ${test} ${s(k)} ? 1 : 0;`);
      }

      return;
    }

    case PbjOp.dot:
    case PbjOp.distance:
    case PbjOp.length: {
      // A sum a lane at a time, into the destination's first lane.
      const count = o.op === PbjOp.length ? o.src.size : n;
      const t = w.temp();
      w.open("{");
      w.emit(`float ${t} = 0.0;`);
      for (let k = 0; k < count; k++) {
        if (o.op === PbjOp.dot) {
          w.emit(`${t} += ${d(k)} * ${s(k)};`);
        } else if (o.op === PbjOp.distance) {
          w.emit(`${t} += (${d(k)} - ${s(k)}) * (${d(k)} - ${s(k)});`);
        } else {
          w.emit(`${t} += ${s(k)} * ${s(k)};`);
        }
      }

      w.emit(`${d(0)} = ${o.op === PbjOp.dot ? t : `sqrt(${t})`};`);
      w.close();
      return;
    }

    case PbjOp.normalize: {
      const t = w.temp();
      w.open("{");
      w.emit(`float ${t} = 0.0;`);
      for (let k = 0; k < n; k++) {
        w.emit(`${t} += ${s(k)} * ${s(k)};`);
      }

      w.emit(`${t} = sqrt(${t});`);
      for (let k = 0; k < n; k++) {
        w.emit(`${d(k)} = ${s(k)} / ${t};`);
      }

      w.close();
      return;
    }

    case PbjOp.cross: {
      const t = w.temp();
      w.open("{");
      w.emit(`vec3 ${t}a = vec3(${d(0)}, ${d(1)}, ${d(2)});`);
      w.emit(`vec3 ${t}b = vec3(${s(0)}, ${s(1)}, ${s(2)});`);
      w.emit(`${d(0)} = ${t}a.y * ${t}b.z - ${t}a.z * ${t}b.y;`);
      w.emit(`${d(1)} = ${t}a.z * ${t}b.x - ${t}a.x * ${t}b.z;`);
      w.emit(`${d(2)} = ${t}a.x * ${t}b.y - ${t}a.y * ${t}b.x;`);
      w.close();
      return;
    }

    case PbjOp.floatToInt:
      each((_, b) => `pbFtoi(${b})`);
      return;
    case PbjOp.intToFloat:
      each((_, b) => `float(${b})`);
      return;
    case PbjOp.floatToBool:
      // The float's bits, as they are.
      each((_, b) => `floatBitsToInt(${b})`);
      return;
    case PbjOp.boolToFloat:
    case PbjOp.boolToInt:
      // The int 1 or 0, its bits taken as a float's.
      each((_, b) => `intBitsToFloat(${b} == 0 ? 0 : 1)`);
      return;
    case PbjOp.matMatMul:
    case PbjOp.matVecMul:
    case PbjOp.vecMatMul:
      // adl takes them on registers that are no matrices; what it does then is not known.
      return;
    default:
      each((_, b) => mathOf(o.op, b));
      return;
  }
}

/** The functions of one argument. */
function mathOf(op: number, x: string): string {
  switch (op) {
    case PbjOp.rcp:
      return `1.0 / ${x}`;
    case PbjOp.sin:
      return `sin(${x})`;
    case PbjOp.cos:
      return `cos(${x})`;
    case PbjOp.tan:
      return `tan(${x})`;
    case PbjOp.asin:
      return `asin(${x})`;
    case PbjOp.acos:
      return `acos(${x})`;
    case PbjOp.atan:
      return `atan(${x})`;
    case PbjOp.exp:
      return `exp(${x})`;
    case PbjOp.exp2:
      return `exp2(${x})`;
    case PbjOp.log:
      return `log(${x})`;
    case PbjOp.log2:
      return `log2(${x})`;
    case PbjOp.sqrt:
      return `sqrt(${x})`;
    case PbjOp.rsqrt:
      return `1.0 / sqrt(${x})`;
    case PbjOp.abs:
      return `abs(${x})`;
    case PbjOp.sign:
      // 0 for NaN, as adl has it.
      return `pbSign(${x})`;
    case PbjOp.floor:
      return `floor(${x})`;
    case PbjOp.ceil:
      return `ceil(${x})`;
    default:
      // fract
      return `${x} - floor(${x})`;
  }
}

function intOp(w: Writer, o: PbjCompute): void {
  const n = o.dst.size;
  const d = (k: number) => w.at(o.dst, k);
  const s = (k: number) => w.at(o.src, k);
  const each = (f: (d: string, s: string) => string) => {
    for (let k = 0; k < n; k++) {
      w.emit(`${d(k)} = ${f(d(k), s(k))};`);
    }
  };

  switch (o.op) {
    case PbjOp.add:
      each((a, b) => `${a} + ${b}`);
      return;
    case PbjOp.sub:
      each((a, b) => `${a} - ${b}`);
      return;
    case PbjOp.mul:
      each((a, b) => `${a} * ${b}`);
      return;
    case PbjOp.div:
      // Flash crashes dividing by 0; 0 here.
      each((a, b) => `pbDivide(${a}, ${b})`);
      return;
    case PbjOp.mov:
    case PbjOp.intToBool:
      each((_, b) => b);
      return;
    case PbjOp.equal:
      w.emit(`${compareInto(w, 0)} = ${n === 1 ? `${d(0)} == ${s(0)} ? 1 : 0` : "0"};`);
      return;
    case PbjOp.notEqual:
      w.emit(`${compareInto(w, 0)} = ${n === 1 ? `${d(0)} == ${s(0)} ? 0 : 1` : "1"};`);
      return;
    case PbjOp.lessThan:
    case PbjOp.lessThanEqual:
    case PbjOp.vectorEqual:
    case PbjOp.vectorNotEqual: {
      const test = { 42: "<", 43: "<=", 59: "==", 60: "!=" }[o.op] as string;
      for (let k = 0; k < n; k++) {
        w.emit(`${compareInto(w, k)} = ${d(k)} ${test} ${s(k)} ? 1 : 0;`);
      }

      return;
    }

    // The logical operations are bitwise, as adl does them.
    case PbjOp.logicalNot:
      w.emit(`${d(0)} = ~${s(0)};`);
      return;
    case PbjOp.logicalAnd:
      w.emit(`${d(0)} = ${d(0)} & ${s(0)};`);
      return;
    case PbjOp.logicalOr:
      w.emit(`${d(0)} = ${d(0)} | ${s(0)};`);
      return;
    case PbjOp.logicalXor:
      w.emit(`${d(0)} = ${d(0)} ^ ${s(0)};`);
      return;
    case PbjOp.any:
    case PbjOp.all: {
      const any = o.op === PbjOp.any;
      const t = w.temp();
      w.open("{");
      w.emit(`int ${t} = ${any ? "0" : "-1"};`);
      for (let k = 0; k < n; k++) {
        w.emit(`${t} ${any ? "|" : "&"}= ${s(k)};`);
      }

      w.emit(`${d(0)} = ${t};`);
      w.close();
    }
  }
}

/** An operation on matrices, each column as its registers hold it. */
function matrixOp(w: Writer, o: PbjCompute): void {
  const n = o.src.matrix;
  const src = (c: number, r: number) => w.cell(o.src, c, r);
  // A destination that is no matrix takes the columns' lanes from its own on, as far as they go.
  const dst = (c: number, r: number) =>
    o.dst.matrix ? w.cell(o.dst, c, r) : w.lane(o.dst, Math.min(3, (o.dst.channels[c] ?? 0) + r));
  const t = w.temp();
  switch (o.op) {
    case PbjOp.matMatMul: {
      w.open("{");
      for (let c = 0; c < n; c++) {
        for (let r = 0; r < n; r++) {
          const terms = Array.from({ length: n }, (_, k) => `${dst(k, r)} * ${src(c, k)}`);
          w.emit(`float ${t}_${c}_${r} = ${terms.join(" + ")};`);
        }
      }

      for (let c = 0; c < n; c++) {
        for (let r = 0; r < n; r++) {
          w.emit(`${dst(c, r)} = ${t}_${c}_${r};`);
        }
      }

      w.close();
      return;
    }

    case PbjOp.matVecMul:
    case PbjOp.vecMatMul: {
      const v = (k: number) => w.at(o.dst, k);
      w.open("{");
      for (let k = 0; k < n; k++) {
        w.emit(`float ${t}_${k} = ${v(k)};`);
      }

      for (let k = 0; k < n; k++) {
        const terms = Array.from(
          { length: n },
          (_, j) => `${o.op === PbjOp.matVecMul ? src(j, k) : src(k, j)} * ${t}_${j}`,
        );
        w.emit(`${v(k)} = ${terms.join(" + ")};`);
      }

      w.close();
      return;
    }

    default: {
      // add, sub, mul and mov, element by element.
      const sign = { [PbjOp.add]: "+", [PbjOp.sub]: "-", [PbjOp.mul]: "*" }[o.op];
      for (let c = 0; c < n; c++) {
        for (let r = 0; r < n; r++) {
          const to = dst(c, r);
          w.emit(`${to} = ${sign ? `${to} ${sign} ${src(c, r)}` : src(c, r)};`);
        }
      }
    }
  }
}

/**
 * `values`, each input parameter's numbers by the parameter as the
 * interpreter takes them, packed into the uniforms `glsl` reads: each
 * parameter register's four lanes, a matrix by its columns.
 */
export function kernelParameters(
  glsl: KernelGlsl,
  values: Map<PbjParameter, readonly number[]>,
): { floats: Float32Array; ints: Int32Array } {
  const floats = new Float32Array(glsl.floatParams.length * 4);
  const ints = new Int32Array(glsl.intParams.length * 4);
  for (const [p, v] of values) {
    const r = p.register;
    const registers = r.int ? glsl.intParams : glsl.floatParams;
    const lanes = r.int ? ints : floats;
    if (!r.matrix) {
      const base = registers.indexOf(r.index) * 4;
      if (base < 0) {
        continue;
      }

      for (const [k, c] of r.channels.slice(0, r.size || r.channels.length).entries()) {
        lanes[base + c] = v[k] ?? 0;
      }

      continue;
    }

    // A matrix's numbers by columns; a 2x2's columns are two lanes each of one register.
    for (let c = 0; c < r.matrix; c++) {
      for (let k = 0; k < r.matrix; k++) {
        const at =
          r.matrix === 2
            ? registers.indexOf(r.index) * 4 + c * 2 + k
            : registers.indexOf(r.index + c) * 4 + k;
        if (at >= 0) {
          lanes[at] = v[c * r.matrix + k] ?? 0;
        }
      }
    }
  }

  return { floats, ints };
}
