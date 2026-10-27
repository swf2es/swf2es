// Number(array) skips valueOf, toString and the join for an Array whose
// conversion is still the builtins': each result must be the one the
// general path, the [[DefaultValue]] and the read of its string, gives.
// tests/conformance/cases/number-array-conversion.as holds the same against
// avmshell, with the hooks replaced.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { createRuntime, type Runtime, type RuntimeOptions } from "@swf2es/runtime/avm2";
import { runShell } from "../../../packages/cli/dist/index.js";

const generated = fileURLToPath(new URL("../../../oracle/avmplus/generated/", import.meta.url));
const skip = !existsSync(`${generated}builtin.abc`) && "oracle/avmplus missing";

let seed = 1;
const random = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
};

const bits = new DataView(new ArrayBuffer(8));
const anyDouble = () => {
  bits.setUint32(0, (random() * 4294967296) >>> 0);
  bits.setUint32(4, (random() * 4294967296) >>> 0);
  return bits.getFloat64(0);
};

/** A runtime with avmshell's builtins, their toplevel script run. */
async function builtinRuntime(): Promise<Runtime> {
  const wasm = readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm")));
  const compiler = await createCodegen(await WebAssembly.compile(wasm));
  const libraries = ["builtin"].map((name) => ({
    name,
    abc: new Uint8Array(readFileSync(`${generated}${name}.abc`)),
  }));
  let rt: Runtime | null = null;
  await runShell(libraries, [], {
    compiler,
    createRuntime: (options: RuntimeOptions) => {
      rt = createRuntime(options);
      return rt;
    },
    print: () => {},
  });
  const runtime = rt as unknown as Runtime;
  runtime.builtinClass("Array");

  return runtime;
}

test("Number(array) gives what the general path gives, without it", { skip }, async () => {
  const rt = await builtinRuntime();
  const general = rt.toPrimitive.bind(rt);
  let calls = 0;
  rt.toPrimitive = (o, hint) => {
    calls++;
    return general(o, hint);
  };

  const numbers = [
    0,
    -0,
    1,
    -1,
    0.5,
    0.1 + 0.2,
    Number("209.14077758789063"),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MIN_VALUE,
    Number("2.2250738585072009e-308"),
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    1e21,
    Number("1.0000000000000001e21"),
    Number("999999999999999900000"),
    2147483647,
    -2147483648,
    4294967295,
  ];
  for (let i = 0; i < 5000; i++) {
    numbers.push(
      anyDouble(),
      Math.fround((random() - 0.5) * 2000),
      random() * 10 ** (random() * 40),
    );
  }

  const strings = ["", " ", "12", "  12  ", "0x1F", "-0x1F", "0b101", "1e3", "4e", "4e+", "abc"];
  strings.push("Infinity", "-Infinity", "NaN", "-0", "12\0", "\0", "1,2", "1\x0034");
  const elements: unknown[][] = [[], [null], [undefined], [true], [false]];
  for (const n of numbers) {
    elements.push([n]);
  }

  for (const s of strings) {
    elements.push([s], [s, s], [s, 1], [1, s]);
  }

  elements.push([1, 2], [null, null], ["", ""], [undefined, 5], [true, false], [1, 2, 3]);
  for (const values of elements) {
    const a = rt.array(values as never[]);
    const expected = rt.toNumber(general(a, "number"));
    calls = 0;
    const n = rt.toNumber(a);
    assert.ok(Object.is(n, expected), `[${values.map(String)}]: ${n} for ${expected}`);
    // Only an element string with a NUL leaves a longer join to the general path.
    const nul = values.length > 1 && values.some((v) => typeof v === "string" && v.includes("\0"));
    assert.equal(calls, nul ? 1 : 0, `[${values.map(String)}] took the general path`);
  }

  // A hole, whose element the prototypes give, takes the general path.
  const sparse = rt.array([]);
  (sparse.$a as unknown[]).length = 1;
  calls = 0;
  assert.equal(rt.toNumber(sparse), 0);
  assert.equal(calls, 1);
});
