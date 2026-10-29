// Pixel Bender bytecode as readPbj reads it, and what it refuses with which
// error: each refusal here is what adl gives `new Shader(bytes)` for it.
import assert from "node:assert/strict";
import test from "node:test";
import { PbjError, PbjOp, readPbj } from "../../../packages/format/dist/index.js";
import { PbjAssembler } from "../../pbj-assembler.ts";

const head = () => new PbjAssembler().version(1).name("k").param("out", "float4", "f0.rgba", "dst");

function refusal(bytes: Uint8Array): number | null {
  try {
    readPbj(bytes);
    return null;
  } catch (e) {
    assert.ok(e instanceof PbjError, String(e));
    return e.errorID;
  }
}

test("a kernel's name, metadata, parameters, inputs and operations", () => {
  const kernel = readPbj(
    new PbjAssembler()
      .version(1)
      .name("Twirl")
      .meta("namespace", "string", "ns")
      .meta("version", "int", -2)
      .param("in", "float2", "f0.rg", "_OutCoord")
      .input(1, 4, "src")
      .param("out", "float4", "f1.rgba", "dst")
      .param("in", "float", "f2.r", "radius")
      .meta("defaultValue", "float", 0.1, true)
      .meta("description", "string", "how far", true)
      .meta("ignored", "int", 3)
      .param("in", "matrix3x3", "f3.m3", "m")
      .param("in", "int2", "i1.gb", "n")
      .sample(true, "f4.rgba", "f0.rg", 1)
      .op("mov", "f1.rgba", "f4.rgba")
      .bytes(),
  );

  assert.equal(kernel.name, "Twirl");
  // The first opcode's metadata are the kernel's wherever they stand; ints as 16 unsigned bits.
  assert.deepEqual(kernel.metadata, [
    { key: "namespace", type: 0xc, value: "ns" },
    { key: "version", type: 0x8, value: [65534] },
    { key: "ignored", type: 0x8, value: [3] },
  ]);
  assert.deepEqual(kernel.inputs, [{ name: "src", index: 1, channels: 4 }]);
  assert.deepEqual(
    kernel.parameters.map((p) => [p.name, p.type, p.output]),
    [
      ["_OutCoord", 2, false],
      ["dst", 4, true],
      ["radius", 1, false],
      ["m", 6, false],
      ["n", 9, false],
    ],
  );
  const radius = kernel.parameters[2];
  assert.deepEqual(radius.register, { index: 2, int: false, channels: [0], size: 1, matrix: 0 });
  assert.deepEqual(
    radius.metadata.map((m) => [m.key, m.value]),
    [
      ["defaultValue", [Math.fround(0.1)]],
      ["description", "how far"],
    ],
  );
  assert.equal(kernel.parameters[3].register.matrix, 3);
  assert.deepEqual(kernel.parameters[4].register.channels, [1, 2]);
  assert.equal(kernel.operations.length, 2);
  assert.deepEqual(kernel.operations[0], {
    op: PbjOp.sampleLinear,
    dst: { index: 4, int: false, channels: [0, 1, 2, 3], size: 4, matrix: 0 },
    src: { index: 0, int: false, channels: [0, 1, 0, 0], size: 2, matrix: 0 },
    texture: 1,
  });
});

test("a kernel without a name or version, and a loaded int cut to 16 bits", () => {
  const kernel = readPbj(
    new PbjAssembler().param("out", "float4", "f0.rgba", "dst").ld("i1.rg", -1).bytes(),
  );
  assert.equal(kernel.name, null);
  assert.deepEqual(kernel.operations[0], {
    op: PbjOp.load,
    dst: { index: 1, int: true, channels: [0, 1], size: 2, matrix: 0 },
    value: 65535,
  });
});

test("bytes that end inside an opcode are EOFError 2030", () => {
  assert.equal(refusal(new Uint8Array([0])), 2030);
  assert.equal(refusal(new Uint8Array([0xa4])), 2030);
  assert.equal(refusal(new PbjAssembler().version(1).raw(0xa4, 0xff, 0, 0x6b).bytes()), 2030);
  assert.equal(refusal(head().raw(0x1d, 0, 0, 0xf0).bytes()), 2030);
  // A nop cut short, whatever bytes it has.
  assert.equal(refusal(head().raw(0, 1, 0, 0).bytes()), 2030);
  assert.equal(refusal(head().raw(0, 0, 0, 0, 1).bytes()), 2030);
  // A metadata type adl cannot size reads on to the end.
  assert.equal(refusal(head().raw(0xa0, 0x11, 0x6b, 0, 0, 0).bytes()), 2030);
});

test("what adl refuses with ArgumentError 2004", () => {
  const cases: [string, Uint8Array][] = [
    ["no bytes", new Uint8Array(0)],
    ["no output", new PbjAssembler().version(1).name("k").bytes()],
    ["version 2", new PbjAssembler().version(2).param("out", "float4", "f0.rgba", "d").bytes()],
    ["an unknown opcode", head().raw(0x3f, 0, 0, 0, 0, 0, 0, 0).bytes()],
    ["a nop with bytes", head().raw(0, 1, 2, 3, 4, 5, 6).bytes()],
    ["a string parameter", head().raw(0xa1, 1, 0x0c, 1, 0, 8, 0x78, 0).bytes()],
    ["a parameter named name", head().param("in", "float", "f1.r", "name").bytes()],
    ["an int output", new PbjAssembler().version(1).param("out", "int4", "i0.rgba", "dst").bytes()],
    ["float metadata of the first opcode", head().meta("k", "float", 1).bytes()],
    ["an int destination of sin", head().op("sin", "i1.r", "i2.r").bytes()],
    ["a float source of logicalNot", head().op("logicalnot", "f1.r", "f2.r").bytes()],
    ["kinds that differ for add", head().op("add", "f1.r", "i1.r").bytes()],
    ["sizes that differ for mov", head().op("mov", "f0.r", "f1.rg").bytes()],
    ["a write mask of nothing", head().raw(0x1d, 0, 0, 0x00, 1, 0, 0, 0).bytes()],
    ["length of a scalar", head().op("length", "f1.r", "f2.r").bytes()],
    ["cross of two", head().op("cross", "f1.rg", "f2.rg").bytes()],
    ["a float condition", head().if("f1.r").endif().bytes()],
    ["an if never ended", head().ld("i1.r", 1).if("i1.r").bytes()],
    ["an else alone", head().else().bytes()],
    ["two elses", head().ld("i1.r", 1).if("i1.r").else().else().endif().bytes()],
    ["select of mixed kinds", head().select("f0.g", "i1.g", "i2.r", "f2.g").bytes()],
    ["sampling into an int", head().input(0, 4, "s").sample(false, "i1.rgba", "f1.rg", 0).bytes()],
    ["matrices divided", head().op("div", "f10.m2", "f4.m2").bytes()],
  ];
  for (const [what, bytes] of cases) {
    assert.equal(refusal(bytes), 2004, what);
  }
});

test("what adl takes that Ruffle's parser does not", () => {
  const cases: [string, Uint8Array][] = [
    ["a high register", head().ld("f32767.r", 1).bytes()],
    ["an if nested", head().ld("i1.r", 1).if("i1.r").if("i1.r").endif().endif().bytes()],
    ["select of all ints", head().select("i0.g", "i1.g", "i2.r", "i2.g").bytes()],
    ["any of four into one", head().op("any", "i1.r", "i2.rgba").bytes()],
    ["a matrix added", head().op("add", "f10.m3", "f4.m3").bytes()],
    ["matrix times vector", head().op("matvecmul", "f2.rgba", "f4.m4").bytes()],
    ["an undeclared texture", head().sample(false, "f1.rgba", "f2.rg", 3).bytes()],
    ["an unknown parameter type", head().raw(0xa1, 1, 0x11, 1, 0, 8, 0x78, 0).bytes()],
    ["metadata of an output", head().meta("k", "float4", [1, 2, 3, 4], true).bytes()],
  ];
  for (const [what, bytes] of cases) {
    assert.equal(refusal(bytes), null, what);
  }
});
