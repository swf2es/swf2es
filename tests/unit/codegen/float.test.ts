import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import { compileFloatLibrary, GENERATED, generated } from "../../libraries/float.ts";
import { libraryAbcs } from "../../player/libraries.ts";
import { abc, tables } from "./abc-builder.ts";
import { testing } from "./testing-module.ts";

const builtin = new Uint8Array(
  readFileSync(new URL("../../../oracle/avmplus/generated/builtin.abc", import.meta.url)),
);
const program = (code: number[], floats: number[] = [16777216, 1]) =>
  abc(
    { floats, strings: ["1", "0b1"] },
    tables({
      methods: [{}],
      scripts: [{ init: 0 }],
      bodies: [{ method: 0, code, maxStack: 4, localCount: 1 }],
    }),
  );

function run(code: number[], floats?: number[]): unknown {
  testing.domainReset(50);
  assert.equal(testing.domainAdd(builtin, true), 0);
  assert.equal(testing.domainAdd(avm2.floatLibrary, true), 0);
  assert.equal(testing.domainAdd(program(code, floats), false), 0);
  const body = testing.domainEmit(0) as string;
  const rt = avm2.createRuntime();
  return new Function("rt", "$dx", `return ${body}`)(rt, rt.defaultXmlNamespace).call({});
}

test("the scalar float builtin is generated from its AS3 declarations", () => {
  assert.deepEqual(compileFloatLibrary(), avm2.floatLibrary);
  assert.equal(readFileSync(GENERATED, "utf8"), generated(avm2.floatLibrary));
});

test("AIR float pools preserve following strings and reject truncated or excessive counts", () => {
  const bytes = abc({ floats: [0.5, -0.25], strings: ["after float"] });
  assert.equal(
    (testing.poolDump(bytes) as string).trimEnd(),
    "float 1 0.5\nfloat 2 -0.25\nstring 1 after float",
  );
  for (const tail of [[2], [2, 0, 0, 0], [0xff, 0xff, 0xff, 0xff, 3]]) {
    assert.match(
      testing.poolDump(new Uint8Array([16, 0, 47, 0, 0, 0, 0, ...tail])) as string,
      /error 1107/,
    );
  }
});

test("pushfloat checks its pool index and scalar extensions stay illegal in Flash ABCs", () => {
  for (const index of [0, 3]) {
    assert.match(testing.codeDump(program([0x22, index, 0x48])) as string, /error 1032/);
  }
  for (const code of [
    [0x22, 1, 0x48],
    [0x24, 1, 0x79, 0x48],
    [0x24, 1, 0x7a, 0x48],
  ]) {
    const old = abc(
      {},
      tables({ methods: [{}], scripts: [{ init: 0 }], bodies: [{ method: 0, code, maxStack: 1 }] }),
    );
    assert.match(testing.codeDump(old) as string, /error 1011/);
  }
});

test("float arithmetic rounds each result, and conversion to Number drops float identity", () => {
  const sum = run([0x22, 1, 0x22, 2, 0xa0, 0x48]);
  assert.ok(sum instanceof avm2.FloatValue);
  assert.equal(sum.value, 16777216);
  assert.equal(run([0x22, 1, 0x75, 0x22, 2, 0x75, 0xa0, 0x48]), 16777217);
  const converted = run([0x24, 1, 0x79, 0x48]);
  assert.ok(converted instanceof avm2.FloatValue);
  assert.equal(converted.value, 1);
});

test("AIR unary operations still apply AS3 Number conversion to strings", () => {
  assert.equal(run([0x2c, 1, 0x91, 0x48]), 2);
  assert.equal(run([0x2c, 1, 0x93, 0x48]), 0);
  assert.equal(run([0x2c, 1, 0xd4, 0x92, 0, 0xd0, 0x48]), 2);
  assert.equal(run([0x2c, 1, 0xd4, 0x94, 0, 0xd0, 0x48]), 0);
  assert.ok(Number.isNaN(run([0x2c, 2, 0x90, 0x48])));
});

test("AIR Number-only arithmetic keeps the same direct JavaScript as Flash bytecode", () => {
  const codes = [
    ...[0xa1, 0xa2, 0xa3, 0xa4].map((op) => [0x2f, 1, 0x2f, 2, op, 0x48]),
    ...[0x90, 0x91, 0x93].map((op) => [0x2f, 1, op, 0x48]),
    ...[0x92, 0x94].map((op) => [0x2f, 1, 0xd4, op, 0, 0xd0, 0x48]),
  ];
  for (const code of codes) {
    const bodies = [false, true].map((modern) => {
      const bytes = abc(
        { doubles: [2.5, 1.5], ...(modern ? { floats: [] } : {}) },
        tables({
          methods: [{}],
          scripts: [{ init: 0 }],
          bodies: [{ method: 0, code, maxStack: 2, localCount: 1 }],
        }),
      );
      testing.domainReset(50);
      assert.equal(testing.domainAdd(builtin, true), 0);
      assert.equal(testing.domainAdd(avm2.floatLibrary, true), 0);
      assert.equal(testing.domainAdd(bytes, false), 0);
      const body = testing.domainEmit(0) as string;
      assert.match(body, /^function/);

      return body;
    });

    assert.equal(bodies[1], bodies[0], `bytecode: ${code.join(" ")}`);
  }
});

test("typed float locals round each operation and allocate only when the result escapes", () => {
  const code = [0xd1, 0xd6];
  for (let i = 0; i < 64; i++) {
    code.push(0xd2, 0x22, 1, 0xa0, 0xf0, i + 1, 0x2a, 0x79, 0xd6, 0x29);
  }

  code.push(0xd2, 0x48);
  const bytes = abc(
    {
      floats: [0.1],
      strings: ["float", ""],
      namespaces: [[0x16, 2]],
      multinames: [[7, 1, 1]],
    },
    tables({
      methods: [{ params: [1], ret: 1 }],
      scripts: [{ init: 0 }],
      bodies: [{ method: 0, localCount: 3, maxStack: 2, code }],
    }),
  );
  testing.domainReset(50);
  testing.domainAdd(builtin, true);
  testing.domainAdd(avm2.floatLibrary, true);
  assert.equal(testing.domainAdd(bytes, false), 0);
  const body = testing.domainEmit(0) as string;
  const rt = avm2.createRuntime();
  const input = rt.float(0.1);
  const float = rt.float.bind(rt);
  let allocations = 0;
  rt.float = (value) => {
    allocations++;
    return float(value);
  };
  const result = new Function("rt", "$dx", `return ${body}`)(rt, rt.defaultXmlNamespace)(input);
  let expected = input.value;
  for (let i = 0; i < 64; i++) {
    expected = Math.fround(expected + Math.fround(0.1));
  }

  assert.ok(result instanceof avm2.FloatValue);
  assert.equal(result.value, expected);
  assert.equal(allocations, 1);
});

test("float defaults preserve dynamic identity and coerce numeric parameter defaults", () => {
  for (const [param, value, modern] of [
    [0, 0, true],
    [0, 1, true],
    [2, 1, true],
    [3, 1, true],
    [0, 0, false],
  ] as const) {
    const bytes = abc(
      {
        ...(modern ? { floats: [0.5] } : {}),
        strings: ["take", "float", "Number", ""],
        namespaces: [[0x16, 4]],
        multinames: [
          [7, 1, 1],
          [7, 1, 2],
          [7, 1, 3],
        ],
      },
      tables({
        methods: [{}, { params: [param], optional: [[value, 2]] }],
        scripts: [{ init: 0, traits: [{ name: 1, kind: 1, index: 1 }] }],
        bodies: [
          { method: 0, code: [0x47] },
          { method: 1, localCount: 2, maxStack: 1, code: [0xd1, 0x48] },
        ],
      }),
    );
    testing.domainReset(50);
    testing.domainAdd(builtin, true);
    testing.domainAdd(avm2.floatLibrary, true);
    assert.equal(testing.domainAdd(bytes, false), 0);
    const body = testing.domainEmit(1) as string;
    assert.match(body, /^function/);
    const rt = avm2.createRuntime();
    const result = new Function("rt", "$dx", `return ${body}`)(rt, rt.defaultXmlNamespace).call({});
    if (!modern) {
      assert.equal(result, undefined);
    } else if (param === 3) {
      assert.equal(result, 0.5);
    } else {
      assert.ok(result instanceof avm2.FloatValue);
      assert.ok(value === 0 ? Number.isNaN(result.value) : result.value === 0.5);
    }
  }
});

test("scalar AIR modules compile identically whole, lazily, and after unrelated methods", async () => {
  const module = await WebAssembly.compile(
    readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const cg = await createCodegen(module);
  const bytes = new Uint8Array(
    readFileSync(new URL("../../player/fixtures/AirFloat.abc", import.meta.url)),
  );
  const libraries = [...libraryAbcs(), avm2.floatLibrary];
  for (const library of libraries) {
    assert.equal(cg.add(library, true), 0);
  }
  assert.equal(cg.add(bytes), 0);
  const compiled = cg.compile();
  assert.ok(compiled.entries.size > 1);
  assert.doesNotMatch(compiled.module, /verifyError\(/);
  assert.deepEqual(cg.compileMethods([...compiled.entries.keys()].reverse()), compiled.entries);
  assert.equal(cg.add(program([0x22, 1, 0x48])), 0);
  cg.compile();
  assert.equal(cg.compileModule(undefined, libraries.length), compiled.module);
});
