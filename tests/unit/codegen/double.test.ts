import assert from "node:assert/strict";
import { test } from "node:test";
import { abc } from "./abc-builder.ts";
import { type Build, loadTesting } from "./testing-module.ts";

const POWERS10 = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000];

// Doubles whose Grisu2 digits end ten places past the integer part, and the
// text codegen has always printed for them: the last digit unrounded. A
// multiplier over 5e8 for 10^10 rounds them otherwise.
const PRINTED: [number, string][] = [
  [6.1300000000000005e-22, "6.1300000000000009e-22"],
  [3.8712999999999997e-22, "3.8712999999999999e-22"],
  [3.3493069370161103e-14, "3.3493069370161106e-14"],
  [2396245078700000000, "2396245078700000500.0"],
];

/** Where POWERS10 of AssemblyScript's number formatting is in `memory`, in words. */
function powers10(memory: WebAssembly.Memory): number {
  const words = new Uint32Array(memory.buffer);
  const found: number[] = [];
  for (let i = 0; i + POWERS10.length <= words.length; i++) {
    if (POWERS10.every((n, k) => words[i + k] === n)) {
      found.push(i);
    }
  }

  assert.equal(found.length, 1);
  return found[0];
}

async function printed(build: Build): Promise<string[]> {
  const testing = await loadTesting(build);
  const dump = (): string[] =>
    (testing.poolDump(abc({ doubles: PRINTED.map(([d]) => d) })) as string)
      .trimEnd()
      .split("\n")
      .map((line) => line.split(" ")[2]);
  const before = dump();

  // The word after the table, read as 10^10 when it overran, made as large
  // as a word gets: the digits must not change. Only that word matters: from
  // 10^11 on, no u32 is large enough to round.
  const words = new Uint32Array(testing.memory.buffer);
  const after = powers10(testing.memory) + POWERS10.length;
  const kept = words[after];
  words[after] = 0xffffffff;
  const poisoned = dump();
  new Uint32Array(testing.memory.buffer)[after] = kept;

  assert.deepEqual(poisoned, before);
  return before;
}

test("doubles print without reading past AssemblyScript's table of powers of ten", async () => {
  const text = await printed(process.env.SWF2ES_CHECKED ? "dist-test-checked" : "dist-test");
  assert.deepEqual(
    text,
    PRINTED.map(([, s]) => s),
  );
  for (const [i, [d]] of PRINTED.entries()) {
    assert.equal(Number(text[i]), d);
  }
});
