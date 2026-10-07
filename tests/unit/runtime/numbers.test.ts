// numberToString writes a number with JavaScript's String where that gives
// avmplus' text, and with the port of avmplus' D2A elsewhere: the two must
// never differ. Seeded samples from where numbers come from in SWFs, and
// from everywhere doubles reach.
import assert from "node:assert/strict";
import { test } from "node:test";
import { convertDoubleToString } from "../../../packages/runtime/dist/avm2/numbers.js";
import { numberToString } from "../../../packages/runtime/dist/avm2/runtime.js";

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

const samples: (() => number)[] = [
  // Decimals as scripts write them, and what arithmetic makes of them.
  () => Math.round(random() * 1e6) / 10 ** Math.floor(random() * 8),
  () => 0.1 * Math.floor(random() * 1000),
  () => random() * 10 ** (Math.floor(random() * 30) - 8),
  () => 1 / Math.floor(random() * 1000 + 1),
  // float32s: coordinates in twips, colour transforms, alphas.
  () => Math.fround(Math.floor(random() * 1e6) / 20),
  () => Math.fround(random() * 2000 - 1000),
  () => Math.floor(random() * 256) / 256,
  // Integers past int, and either side of each power of ten.
  () => Math.floor(random() * 2 ** 53) * (random() < 0.5 ? -1 : 1),
  () => {
    const p = 10 ** (Math.floor(random() * 30) - 8);
    return p * (1 + (random() - 0.5) * 1e-12);
  },
  anyDouble,
];

/** The double just below a positive `n`. */
const below = (n: number) => {
  bits.setFloat64(0, n);
  bits.setBigUint64(0, bits.getBigUint64(0) - 1n);
  return bits.getFloat64(0);
};

test("numberToString writes every number as avmplus' D2A does", () => {
  const edges = [0, -0, 1e-6, 1e-7, below(1e-6), 1e21, below(1e21), 1e15, 1e16];
  for (const n of [...edges, ...edges.map((e) => -e), Number.MIN_VALUE, Number.MAX_VALUE]) {
    assert.equal(numberToString(n), convertDoubleToString(n), String(n));
  }

  for (let i = 0; i < 400_000; i++) {
    const n = samples[i % samples.length]();
    const fast = numberToString(n);
    const full = convertDoubleToString(n);
    if (fast !== full) {
      assert.fail(`${n}: ${fast} where avmplus writes ${full}`);
    }
  }
});
