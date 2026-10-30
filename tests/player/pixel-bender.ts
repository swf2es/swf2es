// Pixel Bender kernels run both ways on the same random inputs: by the CPU
// interpreter (bitmap/pixel-bender.ts), the reference, and as the GLSL a
// ShaderFilter draws with (scene/pixel-bender-glsl.ts in
// @swf2es/render's kernel-shaders.ts), over a random image sampled nearest
// and linearly, transparent past its edges, and a random image of floats
// past 0 to 1, as a Vector.<Number> gives, with random parameters. Each
// family of operations has a kernel of its own, and random programs of
// them follow. Their bytes must agree within a level or two: the GPU's
// transcendentals and float rounding are its own, and a value that lands
// across a floor, a step or a comparison from the CPU's may go the other
// way, which few pixels may do. --gpu runs them on the machine's GPU, not
// software GL.
import assert from "node:assert/strict";
import { PbjAssembler } from "../pbj-assembler.ts";
import { withPage } from "./chrome.ts";

/** A seeded generator, xorshift: the same programs on every run. */
function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

const head = (name: string) =>
  new PbjAssembler()
    .version(1)
    .name(name)
    .param("in", "float2", "f0.rg", "_OutCoord")
    .input(0, 4, "src")
    .param("out", "float4", "f1.rgba", "dst")
    .param("in", "float4", "f2.rgba", "p")
    .meta("defaultValue", "float4", [0.3, 0.7, 1.9, -0.4], true)
    .param("in", "int2", "i1.rg", "n")
    .meta("defaultValue", "int2", [3, -7], true);

/** Ends a kernel: its result's lanes wrapped into 0 to 1, alpha at least a half. */
const finish = (a: PbjAssembler, from: string) =>
  a
    .op("mov", "f1.rgba", from)
    .op("fract", "f1.rgb", "f1.rgb")
    .ld("f6.a", 0.5)
    .op("max", "f1.a", "f6.a")
    .bytes();

const families: [string, Uint8Array][] = [
  [
    "arithmetic",
    finish(
      head("Arithmetic")
        .sample(false, "f3.rgba", "f0.rg", 0)
        .op("mov", "f4.rgba", "f2.rgba")
        .op("mul", "f4.rgba", "f3.gbar")
        .op("add", "f4.rg", "f0.gr")
        .op("sub", "f4.ba", "f3.rg")
        .op("div", "f4.r", "f2.b")
        .op("min", "f4.g", "f3.r")
        .op("max", "f4.b", "f3.a")
        .op("mod", "f4.a", "f2.b")
        .op("step", "f4.r", "f3.b"),
      "f4.rgba",
    ),
  ],
  [
    "functions",
    finish(
      head("Functions")
        .sample(true, "f3.rgba", "f0.rg", 0)
        .op("mov", "f4.rgba", "f3.rgba")
        .op("sin", "f4.r", "f3.g")
        .op("cos", "f4.g", "f3.b")
        .op("sqrt", "f4.b", "f3.a")
        .op("exp", "f4.a", "f3.r")
        .op("log2", "f5.r", "f2.b")
        .op("atan", "f5.g", "f3.r")
        .op("abs", "f5.b", "f2.a")
        .op("rsqrt", "f5.a", "f2.b")
        .op("add", "f4.rgba", "f5.rgba")
        .op("atan2", "f4.r", "f3.g")
        .op("pow", "f4.g", "f2.g")
        .op("sign", "f5.r", "f2.a")
        .op("floor", "f5.g", "f2.b")
        .op("ceil", "f5.b", "f2.a")
        .op("mul", "f4.rgb", "f5.rgb"),
      "f4.rgba",
    ),
  ],
  [
    "geometry",
    finish(
      head("Geometry")
        .sample(false, "f3.rgba", "f0.rg", 0)
        .op("mov", "f4.rgb", "f3.rgb")
        .op("dot", "f4.rgb", "f2.rgb")
        .op("mov", "f5.rgb", "f2.rgb")
        .op("cross", "f5.rgb", "f3.gbr")
        .op("length", "f4.g", "f5.rgb")
        .op("mov", "f7.rg", "f3.ba")
        .op("distance", "f7.rg", "f2.gb")
        .op("mov", "f4.b", "f7.r")
        .op("normalize", "f6.rgb", "f5.rgb")
        .op("add", "f4.rgb", "f6.rgb")
        .op("mov", "f4.a", "f3.a"),
      "f4.rgba",
    ),
  ],
  [
    "matrices",
    finish(
      head("Matrices")
        .param("in", "matrix3x3", "f8.m3", "m")
        .meta("defaultValue", "matrix3x3", [0.2, 0.7, 0.1, 0.6, -0.2, 0.2, 0.1, 0.3, 0.5], true)
        .sample(true, "f3.rgba", "f0.rg", 0)
        .op("mov", "f4.rgb", "f3.rgb")
        .op("matvecmul", "f4.rgb", "f8.m3")
        .op("mov", "f5.rgb", "f3.gbr")
        .op("vecmatmul", "f5.rgb", "f8.m3")
        .op("add", "f4.rgb", "f5.rgb")
        .op("mov", "f4.a", "f3.a"),
      "f4.rgba",
    ),
  ],
  [
    "ints",
    finish(
      head("Ints")
        .sample(false, "f3.rgba", "f0.rg", 0)
        .op("ftoi", "i2.rg", "f0.rg")
        .op("add", "i2.rg", "i1.rg")
        .op("mul", "i2.r", "i1.g")
        .op("div", "i2.g", "i1.r")
        .op("itof", "f4.rg", "i2.rg")
        .ld("f5.r", 0.01)
        .op("mul", "f4.rg", "f5.rr")
        .op("logicalnot", "i3.r", "i2.r")
        .op("logicaland", "i3.r", "i2.g")
        .op("itof", "f5.g", "i3.r")
        .op("mul", "f5.g", "f5.r")
        .op("add", "f4.r", "f5.g")
        .op("mov", "f4.ba", "f3.ba"),
      "f4.rgba",
    ),
  ],
  [
    "branches",
    finish(
      head("Branches")
        .sample(false, "f3.rgba", "f0.rg", 0)
        .op("mov", "f4.rgba", "f3.rgba")
        .op("lessthan", "f3.r", "f3.g")
        .if("i0.r")
        .op("mov", "f4.b", "f3.b")
        .else()
        .op("mov", "f4.b", "f3.a")
        .endif()
        .op("vectorequal", "f3.rg", "f3.rg")
        .select("f4.a", "i0.g", "f3.r", "f2.g"),
      "f4.rgba",
    ),
  ],
];

/**
 * A random program of float operations on the sampled image, the
 * parameters and the coordinate; `floats` samples a second image too, of
 * floats past 0 to 1, three channels a pixel, nearest and linearly.
 */
function program(seed: number, floats = false): Uint8Array {
  const next = random(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)];
  const lanes = "rgba";
  const swizzle = (n: number) => Array.from({ length: n }, () => pick([...lanes])).join("");
  const mask = (n: number) => {
    const start = Math.floor(next() * (5 - n));
    return lanes.slice(start, start + n);
  };
  const a = head(`Random${seed}`);
  if (floats) {
    a.input(1, 3, "numbers")
      .ld("f8.rg", next() * 6 - 3)
      .op("add", "f8.rg", "f0.rg")
      .sample(next() < 0.5, "f9.rgba", "f8.rg", 1)
      .sample(true, "f10.rgba", "f0.gr", 1)
      .op("add", "f9.rgba", "f10.rgba");
  }

  a.sample(next() < 0.5, "f3.rgba", "f0.rg", 0)
    .ld("f5.rg", next() * 4 - 2)
    .op("add", "f5.rg", "f0.rg")
    .sample(true, "f6.rgba", "f5.rg", 0)
    .op("mov", "f4.rgba", "f2.rgba")
    .op("mov", "f7.rg", "f0.rg")
    .ld("f7.ba", next());
  const binary = ["add", "sub", "mul", "min", "max"];
  const unary = ["sin", "cos", "abs", "fract", "exp", "sqrt"];
  for (let k = 0; k < 24; k++) {
    const n = 1 + Math.floor(next() * 4);
    const dst = pick(["f4", "f5", "f7"]);
    const src = pick(
      ["f2", "f3", "f6", "f4", "f5", "f7", ...(floats ? ["f9"] : [])].filter((r) => r !== dst),
    );
    const op = next() < 0.6 ? pick(binary) : pick(unary);
    // sqrt and exp kept to arguments they keep finite.
    if (op === "sqrt" || op === "exp") {
      // The same lanes in and out, which the sine or the absolute value made safe.
      const m = mask(n);
      a.op(op === "exp" ? "sin" : "abs", `${dst}.${m}`, `${src}.${swizzle(n)}`);
      a.op(op, `${dst}.${m}`, `${dst}.${m}`);
      continue;
    }

    a.op(op, `${dst}.${mask(n)}`, `${src}.${swizzle(n)}`);
  }

  a.op("add", "f4.rgba", "f7.rgba").op("sin", "f4.rgba", "f4.rgba");
  return finish(a, "f4.rgba");
}

interface Result {
  name: string;
  pixels: number;
  /** Pixels whose bytes differ by more than CLOSE in any channel, and the largest difference. */
  apart: number;
  most: number;
  error?: string;
}

/** How far a pixel's bytes may differ and count as the same. */
const CLOSE = 2;
const kernels: [string, Uint8Array][] = [
  ...families,
  ...Array.from({ length: 24 }, (_, i): [string, Uint8Array] => [`random ${i}`, program(i + 1)]),
  ...Array.from({ length: 12 }, (_, i): [string, Uint8Array] => [
    `random floats ${i}`,
    program(i + 101, true),
  ]),
];

const { value, exception } = await withPage(
  "runSwf",
  (evaluate) =>
    evaluate<Result[]>(`(async () => {
    const { readPbj } = await import("@swf2es/format");
    const { PixelBender, outputByte } = await import("/player/bitmap/pixel-bender.js");
    const { kernelGlsl, kernelParameters } = await import("/player/scene/pixel-bender-glsl.js");
    const { filterKernel } = await import("/render/kernel-shaders.js");
    const kernels = ${JSON.stringify(kernels.map(([n, b]) => [n, [...b]]))};
    const W = 48, H = 40;
    // A random image, premultiplied: each colour at most its alpha.
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const pixels = new Uint32Array(W * H);
    const bytes = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const a = Math.floor(rand() * 256);
      const c = [0, 1, 2].map(() => Math.floor(rand() * (a + 1)));
      pixels[i] = ((a << 24) | (c[0] << 16) | (c[1] << 8) | c[2]) >>> 0;
      bytes.set([c[0], c[1], c[2], a], i * 4);
    }

    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    const texture = (data) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    const input = texture(bytes);
    // Floats past 0 to 1, three channels a pixel, the fourth 0 in the texture as the CPU gives it.
    const FW = 17, FH = 13;
    const numbers = new Float32Array(FW * FH * 3);
    const texels = new Float32Array(FW * FH * 4);
    for (let i = 0; i < FW * FH; i++) {
      for (let k = 0; k < 3; k++) {
        numbers[i * 3 + k] = Math.fround(rand() * 6 - 3);
        texels[i * 4 + k] = numbers[i * 3 + k];
      }
    }
    const floatTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, floatTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, FW, FH, 0, gl.RGBA, gl.FLOAT, texels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const target = texture(null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    const vertex = "#version 300 es\\nout vec2 vTextureCoord;\\nvoid main(void) {\\n" +
      "  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\\n" +
      "  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\\n  vTextureCoord = p;\\n}\\n";
    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };

    const results = [];
    for (const [name, code] of kernels) {
      try {
        const kernel = readPbj(new Uint8Array(code));
        // The CPU's, its image transparent past its edges as a filter's source is.
        const cpu = new PixelBender(kernel);
        const values = new Map();
        for (const p of kernel.parameters) {
          if (p.output || p.name === "_OutCoord") continue;
          const d = p.metadata.find((m) => m.key === "defaultValue");
          values.set(p, d ? [...d.value].map((v, i) => (p.type >= 8 && v >= 32768 ? v - 65536 : v)) : []);
        }
        const out = new Float32Array(W * H * 4);
        cpu.run(
          values,
          new Map([
            [0, { width: W, height: H, pixels, channels: 4, clear: true }],
            [1, { width: FW, height: FH, floats: numbers, channels: 3 }],
          ]),
          W,
          H,
          out,
        );

        const glsl = kernelGlsl(kernel);
        const source = filterKernel(
            glsl.source,
            glsl.textures.map((t) => ({ texture: t, layer: t === 0, float: t === 1 })),
          );
        const program = gl.createProgram();
        gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
        gl.attachShader(program, shader(gl.FRAGMENT_SHADER, source));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);
        const u = (n) => gl.getUniformLocation(program, n);
        gl.uniform4f(u("uInputPixel"), W, H, 1 / W, 1 / H);
        gl.uniform4f(u("uTextureRect"), 0, 0, W, H);
        gl.uniform3f(u("uKernelAt"), 0, 0, 1);
        gl.uniform2f(u("uKernelFrame"), W, H);
        gl.uniform2f(u("uOutputAt"), 0, 0);
        gl.uniform4f(u("uKernelRegion"), -1e9, -1e9, 1e9, 1e9);
        const { floats, ints } = kernelParameters(glsl, values);
        if (floats.length) gl.uniform4fv(u("pbFloats"), floats);
        if (ints.length) gl.uniform4iv(u("pbInts"), ints);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, input);
        gl.uniform1i(u("uTexture"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, floatTexture);
        gl.uniform1i(u("pbImage1"), 1);
        gl.viewport(0, 0, W, H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const gpu = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, gpu);
        gl.deleteProgram(program);

        let apart = 0, most = 0;
        for (let i = 0; i < W * H; i++) {
          const a = outputByte(out[i * 4 + 3]);
          const want = [0, 1, 2].map((k) => Math.min(a, outputByte(out[i * 4 + k])));
          want.push(a);
          let d = 0;
          for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(want[k] - gpu[i * 4 + k]));
          if (d > ${CLOSE}) apart++;
          most = Math.max(most, d);
        }
        results.push({ name, pixels: W * H, apart, most });
      } catch (e) {
        results.push({ name, pixels: 0, apart: 0, most: 0, error: String(e?.message ?? e) });
      }
    }
    return results;
  })()`),
  process.argv.includes("--gpu"),
);
assert.equal(exception, null, String(exception));
let failed = 0;
for (const r of value as Result[]) {
  // A few pixels apart, at most 1 in 200, where a value lands across a floor or a comparison.
  const ok = !r.error && r.apart <= r.pixels / 200;
  failed += ok ? 0 : 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${r.name}: ${r.error ?? `${r.apart} of ${r.pixels} pixels apart, most ${r.most}`}`,
  );
}

assert.equal(failed, 0, "kernels the GPU computes otherwise than the interpreter");
console.log("pixel-bender: ok");
