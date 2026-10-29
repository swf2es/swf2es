// Pixel Bender kernels run on the CPU. Each expected value is what adl's
// ShaderJob gave the same kernel, into a Vector.<Number>: float32 exactly,
// odd operations and all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PbjParameter, readPbj } from "../../../../packages/format/dist/index.js";
import {
  PixelBender,
  type ShaderImage,
} from "../../../../packages/player/dist/bitmap/pixel-bender.js";
import { PbjAssembler } from "../../../pbj-assembler.ts";

const CH = "rgba";

const head = () => new PbjAssembler().version(1).name("k").param("out", "float4", "f0.rgba", "dst");

/** `values` loaded into a register's lanes, a load each. */
function load(a: PbjAssembler, reg: string, values: number[]): PbjAssembler {
  for (const [i, v] of values.entries()) {
    a.ld(`${reg}.${CH[i]}`, v);
  }

  return a;
}

/** The kernel run over `width` by `height`, its parameters by name and its images by texture. */
function run(
  bytes: Uint8Array,
  options: {
    values?: Record<string, number[]>;
    images?: Map<number, ShaderImage>;
    width?: number;
    height?: number;
  } = {},
): number[] {
  const program = new PixelBender(readPbj(bytes));
  const width = options.width ?? 1;
  const height = options.height ?? 1;
  const values = new Map<PbjParameter, number[]>();
  for (const [name, v] of Object.entries(options.values ?? {})) {
    values.set(program.kernel.parameters.find((p) => p.name === name) as PbjParameter, v);
  }

  const out = new Float32Array(width * height * program.channels);
  program.run(values, options.images ?? new Map(), width, height, out);
  return Array.from(out);
}

/** A binary operation of f2 (first `a`) and f1 (`b`), then f2 out. */
const binary = (op: string, a: number[], b: number[]) =>
  run(
    load(load(head(), "f2", a), "f1", b)
      .op(op, "f2.rgba", "f1.rgba")
      .op("mov", "f0.rgba", "f2.rgba")
      .bytes(),
  );

/** A unary operation of f1 into f2, then f2 out. */
const unary = (op: string, v: number[]) =>
  run(
    load(load(head(), "f2", [7, 7, 7, 7]), "f1", v)
      .op(op, "f2.rgba", "f1.rgba")
      .op("mov", "f0.rgba", "f2.rgba")
      .bytes(),
  );

/** An int operation of i2 and i1, then i2 out as floats. */
const ints = (op: string, a: number[], b: number[]) =>
  run(
    load(load(head(), "i2", a), "i1", b)
      .op(op, "i2.rgba", "i1.rgba")
      .op("itof", "f0.rgba", "i2.rgba")
      .bytes(),
  );

/** An operation on i2 and i1 from lanes, i0 and i2 preset to 9, then `out` as floats. */
const lanes = (
  op: string,
  dst: string,
  src: string,
  a: number[],
  b: number[],
  out: string,
  kind = "i",
) =>
  run(
    load(
      load(load(load(head(), "i0", [9, 9, 9, 9]), "i2", [9, 9, 9, 9]), `${kind}2`, a),
      `${kind}1`,
      b,
    )
      .op(op, `${kind}2.${dst}`, `${kind}1.${src}`)
      .op(kind === "f" && out === "f2" ? "mov" : "itof", "f0.rgba", `${out}.rgba`)
      .bytes(),
  );

test("float arithmetic, with SSE's NaN rules and C's pow", () => {
  assert.deepEqual(binary("mod", [5, -5, 5, -5], [3, 3, -3, -3]), [2, 1, -1, -2]);
  assert.deepEqual(
    binary("pow", [5, -5, 5, -5], [3, 3, -3, -3]),
    [125, -125, 0.00800000037997961, -0.00800000037997961],
  );
  assert.deepEqual(binary("min", [Number.NaN, Infinity, -Infinity, 1], [1, 0, 0, 0]), [
    1,
    0,
    -Infinity,
    0,
  ]);
  assert.deepEqual(binary("max", [Number.NaN, Infinity, -Infinity, 1], [1, 0, 0, 0]), [
    1,
    Infinity,
    0,
    1,
  ]);
  assert.deepEqual(binary("step", [0.5, -1.25, 3, 0], [2, 0.75, -0.5, 7]), [0, 0, 1, 0]);
  assert.deepEqual(
    binary("atan2", [1, -1, 0, 0], [0, 0, 0, -0]),
    [1.5707963705062866, -1.5707963705062866, 0, 0],
  );
  assert.deepEqual(unary("rcp", [0.5, -1.25, 3, 0]), [
    2,
    -0.800000011920929,
    0.3333333432674408,
    Infinity,
  ]);
  assert.deepEqual(unary("rsqrt", [1e-30, -2.5, 0.999, 100]), [
    999999986991104,
    Number.NaN,
    1.0005004405975342,
    0.10000000149011612,
  ]);
  assert.deepEqual(unary("sign", [Number.NaN, Infinity, -Infinity, -0]), [0, 1, -1, 0]);
  assert.deepEqual(unary("fract", [Number.NaN, Infinity, -Infinity, -0]), [
    Number.NaN,
    Number.NaN,
    Number.NaN,
    0,
  ]);
  assert.deepEqual(
    unary("exp2", [0.5, -1.25, 3, 0]),
    [1.4142135381698608, 0.4204482138156891, 8, 1],
  );
  assert.deepEqual(unary("sqrt", [Number.NaN, Infinity, -Infinity, -0]), [
    Number.NaN,
    Infinity,
    Number.NaN,
    -0,
  ]);
});

test("swizzles and write masks: as many lanes as the destination writes", () => {
  const rcp = load(load(head(), "f2", [7, 7, 7, 7]), "f1", [1, 2, 3, 4]).op(
    "rcp",
    "f2.gb",
    "f1.ar",
  );
  assert.deepEqual(run(rcp.op("mov", "f0.rgba", "f2.rgba").bytes()), [7, 0.25, 1, 7]);
  const add = load(load(head(), "f2", [1, 2, 3, 4]), "f1", [10, 20, 30, 40]).op(
    "add",
    "f2.g",
    "f1.a",
  );
  assert.deepEqual(run(add.op("mov", "f0.rgba", "f2.rgba").bytes()), [1, 42, 3, 4]);
});

test("conversions: ftoi to the nearest even, a float's bits to an int, a bool's as a float", () => {
  const ftoi = (v: number[]) =>
    run(
      load(head(), "f1", v)
        .op("ftoi", "i2.rgba", "f1.rgba")
        .op("itof", "f0.rgba", "i2.rgba")
        .bytes(),
    );
  assert.deepEqual(ftoi([-0.5, 1.5, 2.5, -7.25]), [0, 2, 2, -7]);
  assert.deepEqual(
    ftoi([Number.NaN, Infinity, -Infinity, -0]),
    [-2147483648, -2147483648, -2147483648, 0],
  );
  const ftob = run(
    load(head(), "f1", [0.5, -1.25, 3, 0])
      .op("ftob", "i2.rgba", "f1.rgba")
      .op("itof", "f0.rgba", "i2.rgba")
      .bytes(),
  );
  assert.deepEqual(ftob, [1056964608, -1080033280, 1077936128, 0]);
  const btof = run(
    load(load(head(), "f2", [9, 9, 9, 9]), "i1", [100, 0, 1, 32767])
      .op("btof", "f2.rgba", "i1.rgba")
      .op("mov", "f0.rgba", "f2.rgba")
      .bytes(),
  );
  assert.deepEqual(btof, [1.401298464324817e-45, 0, 1.401298464324817e-45, 1.401298464324817e-45]);
});

test("ints: 32 bits, but a load keeps 16", () => {
  assert.deepEqual(
    ints("add", [-32768, 65535, 70000, -1], [3, 7, 9, 1]),
    [32771, 65542, 4473, 65536],
  );
  assert.deepEqual(ints("mul", [7, -7, 7, -7], [2, 2, -2, -2]), [14, 131058, 458738, -589810]);
  assert.deepEqual(
    ints("div", [-32768, 65535, 70000, -1], [3, 7, 9, 1]),
    [10922, 9362, 496, 65535],
  );
  const negative = load(
    load(load(head(), "i2", [7, 7, 7, 7]), "i1", [2, 2, 2, 2]),
    "i3",
    [0, 0, 0, 0],
  )
    .op("sub", "i3.rgba", "i2.rgba")
    .op("div", "i3.rgba", "i1.rgba")
    .op("itof", "f0.rgba", "i3.rgba");
  assert.deepEqual(run(negative.bytes()), [-3, -3, -3, -3]);
  // Flash crashes dividing by 0; it is 0 here.
  assert.deepEqual(ints("div", [1, 2, 3, 4], [0, 1, 0, 1]), [0, 2, 0, 4]);
});

test("comparisons write i0, equal and notEqual of scalars alone", () => {
  assert.deepEqual(
    lanes("lessthan", "rgba", "rgba", [0.5, -1.25, 3, 0], [2, 0.75, -0.5, 7], "i0", "f"),
    [1, 1, 0, 1],
  );
  assert.deepEqual(
    lanes("lessthan", "g", "b", [0.5, -1.25, 3, 0], [2, 0.75, -0.5, 7], "i0", "f"),
    [1, 9, 9, 9],
  );
  assert.deepEqual(lanes("equal", "r", "r", [1, 2, 3, 4], [1, 0, 0, 0], "i0"), [1, 9, 9, 9]);
  assert.deepEqual(lanes("equal", "rg", "rg", [1, 2, 3, 4], [1, 2, 0, 0], "i0", "f"), [0, 9, 9, 9]);
  assert.deepEqual(
    lanes("notequal", "rgba", "rgba", [1, 2, 3, 4], [1, 2, 3, 4], "i0", "f"),
    [1, 9, 9, 9],
  );
  assert.deepEqual(
    lanes("vectorequal", "rgba", "r", [1, 2, 3, 4], [1, 2, 3, 5], "i0", "f"),
    [1, 0, 0, 0],
  );
});

test("logical operations are bitwise, any and all over the destination's lanes", () => {
  assert.deepEqual(lanes("logicalnot", "r", "r", [9, 9, 9, 9], [1, 1, 1, 1], "i2"), [-2, 9, 9, 9]);
  assert.deepEqual(
    lanes("logicalxor", "r", "r", [-1, 9, 9, 9], [3, 9, 9, 9], "i2"),
    [65532, 9, 9, 9],
  );
  assert.deepEqual(lanes("any", "r", "rgba", [9, 9, 9, 9], [0, 1, 2, -1], "i2"), [0, 9, 9, 9]);
  assert.deepEqual(lanes("any", "rg", "ba", [9, 9, 9, 9], [0, 0, 0, 5], "i2"), [5, 9, 9, 9]);
  assert.deepEqual(lanes("all", "rg", "ba", [9, 9, 9, 9], [0, 1, 2, -1], "i2"), [2, 9, 9, 9]);
  assert.deepEqual(
    lanes("itob", "rgba", "r", [9, 9, 9, 9], [-1, 0, 7, 0], "i2"),
    [65535, 65535, 65535, 65535],
  );
});

test("vector operations write their destination's first lane", () => {
  const v = (op: string, dst: string, src: string, b: number[]) =>
    run(
      load(load(head(), "f2", [1, -2, 3, 0.5]), "f1", b)
        .op(op, dst, src)
        .op("mov", "f0.rgba", "f2.rgba")
        .bytes(),
    );
  assert.deepEqual(v("dot", "f2.rg", "f1.rg", [1, 2, 2, 4]), [-3, -2, 3, 0.5]);
  assert.deepEqual(v("distance", "f2.rg", "f1.rg", [3, 4, 0, 0]), [6.324555397033691, -2, 3, 0.5]);
  assert.deepEqual(v("cross", "f2.gba", "f1.agr", [3, 4, 0, 0]), [1, 7, 6, -8]);
  const length = load(load(head(), "f2", [7, 7, 7, 7]), "f1", [-1, 0.5, 0.25, 2]).op(
    "length",
    "f2.g",
    "f1.rgb",
  );
  assert.deepEqual(
    run(length.op("mov", "f0.rgba", "f2.rgba").bytes()),
    [7, 1.145643949508667, 7, 7],
  );
  const normalize = load(head(), "f1", [1, 2, 2, 4]).op("normalize", "f2.rgba", "f1.rgba");
  assert.deepEqual(
    run(normalize.op("mov", "f0.rgba", "f2.rgba").bytes()),
    [0.20000000298023224, 0.4000000059604645, 0.4000000059604645, 0.800000011920929],
  );
});

test("matrices: columns by registers, a 2x2 in one", () => {
  const matrix = (a: PbjAssembler, base: number, n: number, start: number) => {
    for (let c = 0; c < (n === 2 ? 1 : n); c++) {
      load(
        a,
        `f${base + c}`,
        [0, 1, 2, 3].map((r) => start + c * 4 + r),
      );
    }

    return a;
  };
  const product = (n: number) =>
    run(
      matrix(matrix(head(), 4, n, 1), 20, n, 10)
        .op("matmatmul", `f20.m${n}`, `f4.m${n}`)
        .op("mov", "f0.rgba", "f20.rgba")
        .bytes(),
    );
  assert.deepEqual(product(2), [34, 37, 78, 85]);
  assert.deepEqual(product(3), [92, 98, 104, 13]);
  const times = (op: string) =>
    run(
      load(matrix(head(), 4, 3, 1), "f2", [1, -2, 0.5, 3])
        .op(op, "f2.rgb", "f4.m3")
        .op("mov", "f0.rgba", "f2.rgba")
        .bytes(),
    );
  assert.deepEqual(times("matvecmul"), [-4.5, -5, -5.5, 3]);
  const vec2 = run(
    load(matrix(head(), 4, 2, 1), "f2", [1, -2, 0.5, 3])
      .op("vecmatmul", "f2.rg", "f4.m2")
      .op("mov", "f0.rgba", "f2.rgba")
      .bytes(),
  );
  assert.deepEqual(vec2, [-3, -5, 0.5, 3]);
  const parameter = new PbjAssembler()
    .version(1)
    .param("out", "float4", "f0.rgba", "dst")
    .param("in", "matrix3x3", "f4.m3", "m")
    .op("mov", "f0.rgba", "f5.rgba")
    .bytes();
  assert.deepEqual(run(parameter, { values: { m: [1, 2, 3, 4, 5, 6, 7, 8, 9] } }), [4, 5, 6, 0]);
});

test("control flow: if on any int but 0, select on 1 alone", () => {
  const kernel = new PbjAssembler()
    .version(1)
    .param("out", "float4", "f0.rgba", "dst")
    .param("in", "int", "i1.r", "c")
    .ld("f1.r", 1)
    .ld("f1.g", 0)
    .if("i1.r")
    .ld("f0.r", 1)
    .else()
    .ld("f0.r", 0.5)
    .endif()
    .select("f0.g", "i1.r", "f1.r", "f1.g")
    .bytes();
  assert.deepEqual(run(kernel, { values: { c: [0] } }), [0.5, 0, 0, 0]);
  assert.deepEqual(run(kernel, { values: { c: [1] } }), [1, 1, 0, 0]);
  assert.deepEqual(run(kernel, { values: { c: [2] } }), [1, 0, 0, 0]);
});

test("each pixel starts from zero, _OutCoord its centre", () => {
  const kernel = new PbjAssembler()
    .version(1)
    .param("in", "float2", "f1.rg", "_OutCoord")
    .param("out", "float4", "f0.rgba", "dst")
    .param("in", "float", "f3.r", "p")
    .ld("f2.r", 1)
    .op("add", "f3.r", "f2.r")
    .op("add", "f5.r", "f2.r")
    .op("mov", "f0.rg", "f1.rg")
    .op("mov", "f0.b", "f3.r")
    .op("mov", "f0.a", "f5.r")
    .bytes();
  assert.deepEqual(
    run(kernel, { values: { p: [10] }, width: 2, height: 1 }),
    [0.5, 0.5, 11, 1, 1.5, 0.5, 11, 1],
  );
});

test("sampling a BitmapData: its premultiplied bytes, the edges clamped, linear in 256ths", () => {
  const kernel = (linear: boolean) =>
    new PbjAssembler()
      .version(1)
      .param("in", "float2", "f1.rg", "_OutCoord")
      .input(0, 4, "src")
      .param("out", "float4", "f0.rgba", "dst")
      .param("in", "float2", "f3.rg", "off")
      .op("add", "f1.rg", "f3.rg")
      .sample(linear, "f2.rgba", "f1.rg", 0)
      .op("mov", "f0.rgba", "f2.rgba")
      .bytes();
  const gray = new Uint32Array([0xff000000, 0xff404040, 0xff808080, 0xffffffff]);
  const image = new Map([[0, { width: 4, height: 1, pixels: gray, channels: 4 }]]);
  const reds = (out: number[]) => out.filter((_, i) => i % 4 === 0);
  const sample = (linear: boolean, off: number) =>
    reds(run(kernel(linear), { values: { off: [off, 0] }, images: image, width: 4 }));
  assert.deepEqual(sample(false, -0.51), [0, 0, 0.250980406999588, 0.501960813999176]);
  assert.deepEqual(sample(false, 10), [1, 1, 1, 1]);
  assert.deepEqual(
    sample(true, 0.1),
    [0.02352941408753395, 0.27450981736183167, 0.5490196347236633, 1],
  );
  assert.deepEqual(
    sample(true, 0.5),
    [0.125490203499794, 0.3764706254005432, 0.7490196228027344, 1],
  );
  assert.deepEqual(
    sample(true, -0.25),
    [0, 0.1882353127002716, 0.4392157196998596, 0.874509871006012],
  );

  // Two by two, premultiplied: the row first, then the column, each step cut to a byte.
  const square = new Uint32Array([0xff000000, 0xff00ff00, 0xffff0000, 0x80000080]);
  const two = new Map([[0, { width: 2, height: 2, pixels: square, channels: 4 }]]);
  const at = (x: number, y: number) => run(kernel(true), { values: { off: [x, y] }, images: two });
  assert.deepEqual(
    at(0.37, 0.81),
    [0.5058823823928833, 0.06666667014360428, 0.14901961386203766, 0.847058892250061],
  );
  assert.deepEqual(at(0.5, 1), [0.49803924560546875, 0, 0.250980406999588, 0.7490196228027344]);
});

test("sampling floats: as many channels as the input, linear in floats", () => {
  const kernel = new PbjAssembler()
    .version(1)
    .param("in", "float2", "f1.rg", "_OutCoord")
    .input(0, 4, "src")
    .param("out", "float4", "f0.rgba", "dst")
    .ld("f3.r", 0.5)
    .op("add", "f1.r", "f3.r")
    .sample(true, "f2.rgba", "f1.rg", 0)
    .op("mov", "f0.rgba", "f2.rgba")
    .bytes();
  const floats = new Float32Array([0.1, 0.2, 0.3, 0.4, 5, -6, 7, 8]);
  const images = new Map([[0, { width: 2, height: 1, floats, channels: 4 }]]);
  assert.deepEqual(
    run(kernel, { images }),
    [2.549999952316284, -2.9000000953674316, 3.6500000953674316, 4.199999809265137],
  );
});
