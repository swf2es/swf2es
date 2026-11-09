// The player's Pixel Bender cases (cases.ts): shader jobs, filters,
// blends and fills.
import { PbjAssembler } from "../../pbj-assembler.ts";
import * as w from "../../swf-writer.ts";
import type { Compile } from "../scripts.ts";
import type { PlayerCase } from "./common.ts";

/**
 * The kernels of scripts/ShaderJobs.as, each bound to a ByteArray subclass:
 * a twirl about a centre, sampled linearly; a 3x3 matrix times each
 * pixel's colour, out as three channels; a checkerboard of ftoi, int
 * division, if and select, its colours past its alpha; and floats sampled
 * linearly, scaled.
 */
function shaderJobs(compile: Compile): Uint8Array {
  const coord = (a: PbjAssembler) => a.version(1).param("in", "float2", "f0.rg", "_OutCoord");
  const twirl = twirlKernel();
  const mixer = coord(new PbjAssembler().name("Mixer"))
    .input(0, 4, "src")
    .param("out", "float3", "f1.rgb", "dst")
    .param("in", "matrix3x3", "f4.m3", "m")
    .sample(false, "f2.rgba", "f0.rg", 0)
    .op("mov", "f3.rgb", "f2.rgb")
    .op("matvecmul", "f3.rgb", "f4.m3")
    .ld("f8.rgb", 0.1)
    .op("add", "f3.rgb", "f8.rgb")
    .op("mov", "f1.rgb", "f3.rgb")
    .bytes();
  const checker = coord(new PbjAssembler().name("Checker"))
    .param("out", "float4", "f1.rgba", "dst")
    .param("in", "int", "i1.r", "size")
    .op("ftoi", "i2.rg", "f0.rg")
    .op("div", "i2.rg", "i1.rr")
    .op("add", "i2.r", "i2.g")
    .op("mov", "i4.r", "i2.r")
    .ld("i3.r", 2)
    .op("div", "i4.r", "i3.r")
    .op("mul", "i4.r", "i3.r")
    .op("sub", "i2.r", "i4.r")
    .ld("f5.r", 1)
    .ld("f5.g", 0.25)
    .if("i2.r")
    .ld("f1.rg", 0.8)
    .else()
    .ld("f1.r", 0.2)
    .ld("f1.g", 0.4)
    .endif()
    .select("f1.b", "i2.r", "f5.r", "f5.g")
    .ld("f1.a", 0.6)
    .bytes();
  const stretch = coord(new PbjAssembler().name("Stretch"))
    .input(0, 4, "src")
    .param("out", "float4", "f1.rgba", "dst")
    .param("in", "float2", "f2.rg", "scale")
    .op("mov", "f3.rg", "f0.rg")
    .op("mul", "f3.rg", "f2.rg")
    .sample(true, "f1.rgba", "f3.rg", 0)
    .bytes();
  const kernels: [string, Uint8Array][] = [
    ["TwirlKernel", twirl],
    ["MixerKernel", mixer],
    ["CheckerKernel", checker],
    ["StretchKernel", stretch],
  ];
  return shaderSwf(compile, "ShaderJobs", kernels, 270, 40, 2);
}

/** A SWF of `script`'s class over its frames, each of `kernels` bound to a ByteArray subclass of its name. */
function shaderSwf(
  compile: Compile,
  script: string,
  kernels: [string, Uint8Array][],
  width: number,
  height: number,
  frames: number,
): Uint8Array {
  return w.swf({
    width,
    height,
    frameRate: 24,
    frameCount: frames,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      ...kernels.map(([, bytes], i) => w.binaryData(i + 1, bytes)),
      ...kernels.map(([name]) =>
        w.doAbc(
          compile(
            name,
            `package { import flash.utils.ByteArray; public class ${name} extends ByteArray {} }`,
          ),
          name,
        ),
      ),
      w.doAbc(compile(script), script),
      w.symbolClass([[0, script], ...kernels.map(([name], i): [number, string] => [i + 1, name])]),
      ...Array.from({ length: frames }, () => w.showFrame()),
      w.end(),
    ],
  });
}

/** The twirl of shaderJobs: its input turned about `center` by `amount` a pixel out. */
function twirlKernel(): Uint8Array {
  return new PbjAssembler()
    .name("Twirl")
    .version(1)
    .param("in", "float2", "f0.rg", "_OutCoord")
    .input(0, 4, "src")
    .param("out", "float4", "f1.rgba", "dst")
    .param("in", "float2", "f2.rg", "center")
    .meta("defaultValue", "float2", [20, 20], true)
    .param("in", "float", "f2.b", "amount")
    .meta("defaultValue", "float", 0.15, true)
    .op("mov", "f3.rg", "f0.rg")
    .op("sub", "f3.rg", "f2.rg")
    .op("length", "f3.b", "f3.rg")
    .op("mul", "f3.b", "f2.b")
    .op("sin", "f3.a", "f3.b")
    .op("cos", "f4.r", "f3.b")
    .op("mov", "f4.g", "f3.r")
    .op("mul", "f4.g", "f4.r")
    .op("mov", "f4.b", "f3.g")
    .op("mul", "f4.b", "f3.a")
    .op("sub", "f4.g", "f4.b")
    .op("mov", "f4.b", "f3.r")
    .op("mul", "f4.b", "f3.a")
    .op("mov", "f4.a", "f3.g")
    .op("mul", "f4.a", "f4.r")
    .op("add", "f4.b", "f4.a")
    .op("add", "f4.g", "f2.r")
    .op("add", "f4.b", "f2.g")
    .sample(true, "f1.rgba", "f4.gb", 0)
    .bytes();
}

/**
 * blendShader (scripts/ShaderBlends.as): kernels that show the inputs'
 * order, the coordinate, a result less than opaque, a parameter, and a
 * lighten by luminance; one of one input and one of three, which adl
 * refuses.
 */
function shaderBlends(compile: Compile): Uint8Array {
  const head = (name: string, inputs = 2) => {
    const a = new PbjAssembler().version(1).name(name).param("in", "float2", "f0.rg", "_OutCoord");
    for (let k = 0; k < inputs; k++) {
      a.input(k, 4, "abc"[k]);
    }

    return a.param("out", "float4", "f1.rgba", "dst");
  };
  const order = head("Order")
    .sample(false, "f2.rgba", "f0.rg", 0)
    .sample(false, "f3.rgba", "f0.rg", 1)
    .op("mov", "f1.r", "f2.r")
    .op("mov", "f1.g", "f3.r")
    .op("mov", "f1.b", "f3.a")
    .ld("f4.r", 0.5)
    .op("mul", "f1.b", "f4.r")
    .ld("f4.g", 0.25)
    .op("add", "f1.b", "f4.g")
    .ld("f1.a", 1)
    .bytes();
  const coord = head("Coord")
    .op("floor", "f2.rg", "f0.rg")
    .ld("f4.r", 32)
    .op("add", "f2.rg", "f4.rr")
    .ld("f3.r", 1 / 255)
    .op("mul", "f2.rg", "f3.rr")
    .op("mov", "f1.rg", "f2.rg")
    .ld("f6.rg", 7)
    .op("add", "f6.rg", "f0.rg")
    .sample(true, "f5.rgba", "f6.rg", 0)
    .op("mov", "f1.b", "f5.r")
    .ld("f1.a", 1)
    .bytes();
  const half = head("Half").ld("f1.rb", 0).ld("f1.ga", 0.5).bytes();
  const param = head("Param")
    .param("in", "float4", "f2.rgba", "color")
    .meta("defaultValue", "float4", [0, 0, 1, 1], true)
    .op("mov", "f1.rgba", "f2.rgba")
    .bytes();
  const luma = head("Luma")
    .sample(false, "f2.rgba", "f0.rg", 0)
    .sample(false, "f3.rgba", "f0.rg", 1)
    .ld("f6.r", 0.212671)
    .ld("f6.g", 0.71516)
    .ld("f6.b", 0.072169)
    .op("mov", "f4.rgb", "f2.rgb")
    .op("dot", "f4.rgb", "f6.rgb")
    .op("mov", "f5.rgb", "f3.rgb")
    .op("dot", "f5.rgb", "f6.rgb")
    .op("lessthan", "f4.r", "f5.r")
    .if("i0.r")
    .op("mov", "f1.rgba", "f3.rgba")
    .else()
    .op("mov", "f1.rgba", "f2.rgba")
    .endif()
    .bytes();
  const kernels: [string, Uint8Array][] = [
    ["OrderKernel", order],
    ["CoordKernel", coord],
    ["HalfKernel", half],
    ["ParamKernel", param],
    ["LumaKernel", luma],
    ["OneKernel", head("One", 1).ld("f1.rgba", 1).bytes()],
    ["ThreeKernel", head("Three", 3).sample(false, "f1.rgba", "f0.rg", 2).bytes()],
  ];
  return shaderSwf(compile, "ShaderBlends", kernels, 320, 120, 3);
}

/**
 * Shader fills (scripts/ShaderFills.as): kernels that show their
 * coordinate, sample a bitmap, give a translucent colour and colours past
 * their alpha, and take a parameter; one sampling an input never set,
 * which adl refuses.
 */
function shaderFills(compile: Compile): Uint8Array {
  const head = (name: string) =>
    new PbjAssembler().version(1).name(name).param("in", "float2", "f0.rg", "_OutCoord");
  const coord = head("Coord")
    .param("out", "float4", "f1.rgba", "dst")
    .op("floor", "f2.rg", "f0.rg")
    .ld("f4.r", 64)
    .op("add", "f2.rg", "f4.rr")
    .ld("f3.r", 1 / 255)
    .op("mul", "f2.rg", "f3.rr")
    .op("mov", "f1.rg", "f2.rg")
    .op("fract", "f1.b", "f0.r")
    .ld("f1.a", 1)
    .bytes();
  const image = head("Image")
    .input(0, 4, "src")
    .param("out", "float4", "f1.rgba", "dst")
    .sample(false, "f1.rgba", "f0.rg", 0)
    .bytes();
  const smooth = head("Smooth")
    .param("out", "float4", "f1.rgba", "dst")
    .ld("f2.rg", 1 / 64)
    .op("mov", "f1.rg", "f0.rg")
    .op("mul", "f1.rg", "f2.rg")
    .ld("f2.rg", 0.5)
    .op("add", "f1.rg", "f2.rg")
    .ld("f1.ba", 1)
    .bytes();
  const half = head("Half")
    .param("out", "float4", "f1.rgba", "dst")
    .ld("f1.rb", 0)
    .ld("f1.ga", 0.5);
  const over = head("Over")
    .param("out", "float4", "f1.rgba", "dst")
    .ld("f1.r", 1)
    .ld("f1.g", 0.5)
    .ld("f1.b", 0)
    .ld("f1.a", 0.5);
  const tint = head("Tint")
    .param("out", "float4", "f1.rgba", "dst")
    .param("in", "float4", "f2.rgba", "color")
    .meta("defaultValue", "float4", [0, 0.6, 0.3, 1], true)
    .op("mov", "f1.rgba", "f2.rgba")
    .bytes();
  const kernels: [string, Uint8Array][] = [
    ["CoordKernel", coord],
    ["ImageKernel", image],
    ["SmoothKernel", smooth],
    ["HalfKernel", half.bytes()],
    ["OverKernel", over.bytes()],
    ["TintKernel", tint],
  ];
  return shaderSwf(compile, "ShaderFills", kernels, 320, 160, 3);
}

/**
 * ShaderFilter (scripts/ShaderFilters.as): kernels that show their
 * coordinate and the object's alpha, move the object by whole and part
 * pixels, mix a second input past its edges, tint it by a parameter, turn
 * it, and give colours past their alpha; one of no inputs and one of
 * three channels out, which adl refuses.
 */
function shaderFilters(compile: Compile): Uint8Array {
  const head = (name: string) =>
    new PbjAssembler().version(1).name(name).param("in", "float2", "f0.rg", "_OutCoord");
  const coord = head("Coord")
    .input(0, 4, "src")
    .param("out", "float4", "f1.rgba", "dst")
    .op("floor", "f2.rg", "f0.rg")
    .ld("f4.r", 32)
    .op("add", "f2.rg", "f4.rr")
    .ld("f3.r", 1 / 255)
    .op("mul", "f2.rg", "f3.rr")
    .op("mov", "f1.rg", "f2.rg")
    .sample(false, "f5.rgba", "f0.rg", 0)
    .op("mov", "f1.b", "f5.a")
    .ld("f1.a", 1)
    .bytes();
  const shift = (name: string, dx: number, linear: boolean) =>
    head(name)
      .input(0, 4, "src")
      .param("out", "float4", "f1.rgba", "dst")
      .ld("f2.r", dx)
      .ld("f2.g", -2)
      .op("mov", "f3.rg", "f0.rg")
      .op("sub", "f3.rg", "f2.rg")
      .sample(linear, "f1.rgba", "f3.rg", 0)
      .bytes();
  const two = head("Two")
    .input(0, 4, "a")
    .input(1, 4, "b")
    .param("out", "float4", "f1.rgba", "dst")
    .ld("f2.r", 3)
    .ld("f2.g", 0)
    .op("mov", "f3.rg", "f0.rg")
    .op("add", "f3.rg", "f2.rg")
    .sample(false, "f4.rgba", "f3.rg", 1)
    .sample(false, "f1.rgba", "f0.rg", 0)
    .op("add", "f1.rgba", "f4.rgba")
    .ld("f5.r", 0.5)
    .op("mul", "f1.rgba", "f5.rrrr")
    .bytes();
  const tint = head("Tint")
    .input(0, 4, "src")
    .param("out", "float4", "f1.rgba", "dst")
    .param("in", "float4", "f2.rgba", "color")
    .meta("defaultValue", "float4", [0, 1, 0, 1], true)
    .sample(false, "f1.rgba", "f0.rg", 0)
    .op("mul", "f1.rgba", "f2.rgba")
    .bytes();
  const over = head("Over")
    .input(0, 4, "src")
    .param("out", "float4", "f1.rgba", "dst")
    .ld("f1.r", 1)
    .ld("f1.g", 0.5)
    .ld("f1.b", 0)
    .ld("f1.a", 0.5)
    .bytes();
  const solid = head("Solid").param("out", "float4", "f1.rgba", "dst").ld("f1.rgba", 1).bytes();
  const rgb = head("Rgb")
    .input(0, 4, "src")
    .param("out", "float3", "f1.rgb", "dst")
    .ld("f1.rgb", 0.5)
    .bytes();
  const kernels: [string, Uint8Array][] = [
    ["CoordKernel", coord],
    ["ShiftKernel", shift("Shift", 3, false)],
    ["ShiftLinearKernel", shift("ShiftLinear", 3.25, true)],
    ["TwoKernel", two],
    ["TintKernel", tint],
    ["TwirlKernel", twirlKernel()],
    ["OverKernel", over],
    ["SolidKernel", solid],
    ["RgbKernel", rgb],
  ];
  return shaderSwf(compile, "ShaderFilters", kernels, 320, 170, 3);
}

export const shaderCases: PlayerCase[] = [
  {
    // Pixel Bender kernels run by ShaderJob on the CPU (scripts/ShaderJobs.as); the
    // twirl's sines differ from Flash's in their last bits, a pixel's byte by 1.
    name: "shader-jobs",
    build: shaderJobs,
    frames: 2,
    capture: [2],
    tolerance: 1,
    maxOutliers: 0,
  },
  {
    // ShaderFilter on display objects and through applyFilter (scripts/ShaderFilters.as). The
    // turned box's edges and the twirled ring's are antialiased otherwise than adl's.
    name: "shader-filters",
    build: shaderFilters,
    frames: 3,
    capture: [3],
    tolerance: 32,
    maxOutliers: 60,
  },
  {
    // blendShader (scripts/ShaderBlends.as). adl's bitmap of the blurred square reaches two
    // pixels further, which the kernel paints, and the circle's edges blend here a texel at a
    // time, there a pixel.
    name: "shader-blends",
    build: shaderBlends,
    frames: 3,
    capture: [3],
    tolerance: 2,
    maxOutliers: 450,
  },
  {
    // Shader fills (scripts/ShaderFills.as). The circle's and the triangles' edges are
    // antialiased otherwise than adl's.
    name: "shader-fills",
    build: shaderFills,
    frames: 3,
    capture: [3],
    tolerance: 2,
    maxOutliers: 500,
  },
];
