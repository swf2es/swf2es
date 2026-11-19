// Flash's random numbers (packages/runtime/src/random.ts): avmplus'
// generator, whose sequences from a seed are what its C++ gives (compiled
// with gcc from core/MathUtils.cpp's functions), and whose values are the
// 2^31 multiples of 2^-31 that content relies on. adl's AS3 and AVM1
// sequences are this generator's, Math.random and RandomNumber sharing one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";
import { type Host, Runtime } from "../../../packages/runtime/dist/avm1/index.js";
import { FlashRandom } from "../../../packages/runtime/dist/random.js";

// GenerateRandomNumber's first values from RandomFastInit(seed), by gcc.
const SEQUENCES: [number, number[]][] = [
  [
    1,
    [1745237431, 762975995, 499981080, 1083712695, 983291576, 1948753492, 1566934074, 1836376921],
  ],
  [
    0x12345678,
    [93162315, 1548191310, 645130308, 839827054, 2117272353, 755151787, 1824491686, 1441931484],
  ],
  [
    0xdeadbeef,
    [451512411, 2061321938, 1030815864, 1172566848, 437813886, 1748868643, 126799672, 990566460],
  ],
  [
    0x80000000,
    [1463748861, 1769104005, 1917000419, 32532680, 1586327974, 751812967, 1389733931, 1709067975],
  ],
];

const onGrid = (r: number) => r >= 0 && r < 1 && Number.isInteger(r * 2147483648);

test("a seeded generator gives avmplus' sequence", () => {
  for (const [seed, expected] of SEQUENCES) {
    const random = new FlashRandom(seed);
    assert.deepEqual(
      expected.map(() => random.next()),
      expected,
    );
    random.seed(seed);
    assert.deepEqual(
      expected.map(() => random.random()),
      expected.map((n) => n / 2147483648),
    );
  }

  // A million on, past any short cycle, the sum of all as gcc's.
  const random = new FlashRandom(1);
  let sum = 0;
  let last = 0;
  for (let i = 0; i < 1_000_000; i++) {
    last = random.next();
    sum += last;
  }
  assert.equal(last, 1879420756);
  assert.equal(sum, 1074218349062265);
});

test("every value is a multiple of 2^-31 from 0 below 1", () => {
  const random = new FlashRandom();
  let off = 0;
  for (let i = 0; i < 200_000; i++) {
    if (!onGrid(random.random())) {
      off++;
    }
  }
  assert.equal(off, 0);

  // A state of 0, the LFSR's one fixed point, seeds again from the clock.
  const zero = new FlashRandom(0);
  const first = zero.next();
  assert.ok(first >= 0 && first <= 0x7fffffff);
  assert.notEqual(zero.next(), first);
});

test("Random(range) is the value modulo the range, 0 for a range below 1", () => {
  const random = new FlashRandom(0x12345678);
  const [, expected] = SEQUENCES[1];
  assert.deepEqual(
    expected.map(() => random.range(7)),
    expected.map((n) => n % 7),
  );
  assert.equal(random.range(0), 0);
  assert.equal(random.range(-3), 0);
  assert.equal(random.range(1), 0);

  const seen = new Set<number>();
  for (let i = 0; i < 10_000; i++) {
    seen.add(random.range(5));
  }
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
  );
});

test("AS3's Math.random, Number.random and float.random draw from the runtime's generator", () => {
  const rt = avm2.createRuntime();
  rt.random.seed(1);
  const math = rt.natives["Math.random"](rt) as () => number;
  const number = rt.natives["Number.random"](rt) as () => number;
  const float = rt.natives["float.random"](rt) as () => { value: number };
  const [, expected] = SEQUENCES[0];
  assert.equal(math(), expected[0] / 2147483648);
  assert.equal(number(), expected[1] / 2147483648);
  assert.equal(float().value, Math.fround(expected[2] / 2147483648));
  assert.equal(math(), expected[3] / 2147483648);

  // Each runtime has its own, as each worker and player does.
  const other = avm2.createRuntime();
  assert.notEqual(other.random, rt.random);
  other.random.seed(1);
  assert.equal((other.natives["Math.random"](other) as () => number)(), expected[0] / 2147483648);
});

test("AVM1's Math.random and RandomNumber share the realm's generator", () => {
  const rt = new Runtime();
  const host: Host = { trace() {}, play() {}, stop() {}, halt() {} };
  const cx = rt.activation([], [], {}, rt.newObject(), host);
  rt.realm.current = cx;
  const V = rt.version(8);
  const random = () => {
    cx.st.push(0, rt.realm.Math, "random");
    V.callMethod(cx);
    return cx.st.pop() as number;
  };

  rt.realm.random.seed(0x12345678);
  const [, expected] = SEQUENCES[1];
  assert.equal(random(), expected[0] / 2147483648);
  assert.equal(V.randomNumber(cx, 1000), expected[1] % 1000);
  assert.equal(random(), expected[2] / 2147483648);
  assert.equal(V.randomNumber(cx, 2147483648), expected[3]);
  assert.equal(V.randomNumber(cx, 0), 0);
  assert.equal(V.randomNumber(cx, Number.NaN), 0);

  assert.notEqual(new Runtime().realm.random, rt.realm.random);
});
