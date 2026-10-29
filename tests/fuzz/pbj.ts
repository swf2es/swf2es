// Fuzzes Pixel Bender bytecode: format's readPbj with kernels cut short,
// bits flipped, runs overwritten, opcodes and registers made up, and
// garbage alone, and the player's interpreter with every kernel it reads.
// A script hands flash.display.Shader any bytes, so for any of them
//
//   - readPbj returns a kernel or throws PbjError (2004 or 2030), nothing else;
//   - the interpreter runs each kernel it returns over a few pixels, any
//     parameter values and any images, without throwing and writing only
//     the output's channels a pixel;
//   - a kernel reads the same however often it is read.
//
// The seeds are kernels of every kind of operation, built by the tests'
// assembler. The generator is seeded, so a run repeats exactly:
//
//   node tests/fuzz/pbj.ts [cases, 2000] [seed, 1]
import {
  PBJ_RULES,
  PbjError,
  type PbjParameter,
  readPbj,
} from "../../packages/format/dist/index.js";
import { PixelBender, type ShaderImage } from "../../packages/player/dist/bitmap/pixel-bender.js";
import { PbjAssembler } from "../pbj-assembler.ts";

const caseCount = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 1);

/** mulberry32: a small generator whose sequence the seed fixes. */
function generator(start: number): () => number {
  let s = start >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = generator(seed);
const below = (n: number) => Math.floor(random() * n);
const pick = <T>(items: readonly T[]): T => items[below(items.length)];

const CHANNELS = ["r", "g", "b", "a", "rg", "gb", "rgb", "rgba", "ar", "bgr"];
const FLOATS = [0, 1, -1, 0.5, 2.5, 1e30, -1e-30, Number.NaN, Infinity, -Infinity];

function register(kind: string, size?: number): string {
  const channels = size ? ["r", "rg", "rgb", "rgba"][size - 1] : pick(CHANNELS);
  return `${kind}${below(6)}.${channels}`;
}

/** An operation adl takes: kinds and sizes as its rule has them (PBJ_RULES). */
function operation(a: PbjAssembler): void {
  const [op, rule] = pick([...PBJ_RULES]);
  const k = below(rule.kinds.length / 2) * 2;
  const kind = (v: number) => (v === 1 ? "f" : "i");
  let d = 1 + below(4);
  let s = d;
  switch (rule.sizes) {
    case "any":
      s = 1 + below(4);
      break;
    case "scalar":
      d = s = 1;
      break;
    case "vector":
      d = s = 2 + below(3);
      break;
    case "length":
      d = 1;
      s = 2 + below(3);
      break;
    case "cross":
      d = s = 3;
      break;
  }

  a.op(op, register(kind(rule.kinds[k]), d), register(kind(rule.kinds[k + 1]), s));
}

/** A kernel of random operations over a header of every kind of parameter and two inputs. */
function seedKernel(): Uint8Array {
  const a = new PbjAssembler()
    .version(1)
    .name("fuzz")
    .meta("vendor", "string", "fuzz")
    .param("in", "float2", "f0.rg", "_OutCoord")
    .input(0, 4, "src")
    .input(1, pick([1, 2, 3, 4]), "src2")
    .param("out", pick(["float3", "float4"]), pick(["f1.rgb", "f1.rgba"]), "dst")
    .param("in", "float4", "f2.rgba", "p")
    .meta("defaultValue", "float4", [1, 2, 3, 4], true)
    .param("in", "int2", "i1.rg", "q")
    .param("in", "matrix3x3", "f8.m3", "m");
  let depth = 0;
  for (let n = 0; n < 4 + below(30); n++) {
    const sizes = 1 + below(4);
    switch (below(9)) {
      case 0:
        a.ld(register(pick(["f", "i"])), pick(FLOATS));
        break;
      case 1:
        a.sample(below(2) === 0, register("f"), register("f", 2), below(3));
        break;
      case 2:
        operation(a);
        break;
      case 3:
        a.select(
          register("f", sizes),
          register("i", 1),
          register("f", sizes),
          register("f", sizes),
        );
        break;
      case 4:
        a.if(register("i", 1));
        depth++;
        break;
      case 5:
        if (depth > 0) {
          a.else().endif();
          depth--;
        }

        break;
      case 6: {
        const m = 2 + below(3);
        a.op(pick(["add", "mul", "mov", "matmatmul"]), `f${12 + below(3)}.m${m}`, `f8.m${m}`);
        break;
      }

      default:
        // Now and then one adl refuses.
        if (below(20) === 0) {
          a.op(below(0x40), register(pick(["f", "i"])), register(pick(["f", "i"])));
        } else {
          operation(a);
        }
    }
  }

  for (; depth > 0; depth--) {
    a.endif();
  }

  return a.bytes();
}

function mutate(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  const at = () => below(Math.max(1, out.length));
  switch (below(8)) {
    case 0:
      return out.subarray(0, below(out.length + 1));
    case 1:
      for (let i = 1 + below(6); i > 0; i--) {
        out[at()] ^= 1 << below(8);
      }

      return out;
    case 2: {
      const from = at();
      for (let i = from; i < Math.min(out.length, from + 1 + below(16)); i++) {
        out[i] = below(256);
      }

      return out;
    }
    case 3: {
      const garbage = new Uint8Array(below(200));
      for (let i = 0; i < garbage.length; i++) {
        garbage[i] = below(256);
      }

      return garbage;
    }
    case 4: {
      // An opcode of any value, with its seven bytes.
      const longer = new Uint8Array(out.length + 8);
      longer.set(out);
      for (let i = out.length; i < longer.length; i++) {
        longer[i] = below(256);
      }

      return longer;
    }
    default:
      return out;
  }
}

const failures: string[] = [];
let read = 0;
let refused = 0;

function image(channels: number): ShaderImage {
  const width = 1 + below(4);
  const height = 1 + below(4);
  if (below(2) === 0) {
    const pixels = new Uint32Array(width * height);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = (below(0x10000) * 0x10000 + below(0x10000)) >>> 0;
    }

    return { width, height, pixels, channels };
  }

  const floats = new Float32Array(width * height * channels).map(() => pick(FLOATS));
  return { width, height, floats, channels };
}

for (let n = 0; n < caseCount; n++) {
  const bytes = below(3) === 0 ? seedKernel() : mutate(seedKernel());
  let kernel: ReturnType<typeof readPbj>;
  try {
    kernel = readPbj(bytes);
  } catch (e) {
    if (e instanceof PbjError && (e.errorID === 2004 || e.errorID === 2030)) {
      refused++;
      continue;
    }

    failures.push(`case ${n}: readPbj threw ${e}`);
    continue;
  }

  read++;
  if (JSON.stringify(readPbj(bytes)) !== JSON.stringify(kernel)) {
    failures.push(`case ${n}: a second read differs`);
  }

  try {
    const program = new PixelBender(kernel);
    const values = new Map<PbjParameter, number[]>();
    for (const p of kernel.parameters) {
      values.set(
        p,
        Array.from({ length: 16 }, () => pick(FLOATS)),
      );
    }

    const images = new Map<number, ShaderImage>();
    for (const input of kernel.inputs) {
      images.set(input.index, image(input.channels));
    }

    const width = 1 + below(3);
    const height = 1 + below(3);
    const out = new Float32Array(width * height * program.channels + 1).fill(7);
    program.run(values, images, width, height, out);
    if (out[out.length - 1] !== 7) {
      failures.push(`case ${n}: wrote past its output`);
    }
  } catch (e) {
    failures.push(`case ${n}: running threw ${(e as Error).stack ?? e}`);
  }
}

console.log(`pbj fuzz: ${caseCount} cases from seed ${seed}, ${read} read, ${refused} refused`);
if (failures.length) {
  console.log(failures.slice(0, 20).join("\n"));
  console.log(`${failures.length} failures`);
  process.exit(1);
}
