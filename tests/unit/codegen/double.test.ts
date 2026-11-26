import assert from "node:assert/strict";
import { test } from "node:test";
import { abc } from "./abc-builder.ts";
import { loadTesting, TESTED } from "./testing-module.ts";

// Doubles as the compiler prints them (output.zig's numberText): what
// JavaScript's String prints, the shortest digits that read back as the
// double. Among them, those AssemblyScript's Grisu2 printed with longer or
// other digits, and an integer past 2^53, which it printed with ".0".
const NOTED = [
  6.1300000000000005e-22,
  3.8712999999999997e-22,
  3.3493069370161103e-14,
  2396245078700000000,
  Math.SQRT2,
  0.1 + 0.2,
  209.14077758789062,
  1.2345678901234568e21,
  2 ** 53 + 2,
  1e21,
  1e-7,
  -1.5e-7,
  0.000001234,
  5e-324,
  Number.MAX_VALUE,
  2.2250738585072014e-308,
  -123.456,
];

/** The doubles `doubles` as the test build's pool dump prints them. */
async function printed(doubles: number[]): Promise<string[]> {
  const testing = await loadTesting(TESTED);
  return (testing.poolDump(abc({ doubles })) as string)
    .trimEnd()
    .split("\n")
    .map((line) => line.split(" ")[2]);
}

test("doubles print as JavaScript's String prints them", async () => {
  assert.deepEqual(
    await printed(NOTED),
    NOTED.map((d) => String(d)),
  );
});

test("random doubles print as JavaScript's String prints them", async () => {
  // Any bit pattern but zeros, NaNs and infinities, from a fixed seed.
  let seed = 1;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  const bits = new DataView(new ArrayBuffer(8));
  const doubles: number[] = [];
  while (doubles.length < 4000) {
    bits.setUint32(0, next());
    bits.setUint32(4, next());
    const d = bits.getFloat64(0);
    if (Number.isFinite(d) && d !== 0) {
      doubles.push(d);
    }
  }

  assert.deepEqual(
    await printed(doubles),
    doubles.map((d) => String(d)),
  );
});
