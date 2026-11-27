// float, from a review of the idiomatic pass: methods typed float, their
// parameters, results, locals, defaults and slots, arithmetic and
// conversions on them, as they are and mutated, with float's library, the
// libraries without it, and none; each linked case verified, compiled and
// dumped.
import { readFileSync } from "node:fs";
import { abc, type Method, type Trait, tables } from "../../unit/codegen/abc-builder.ts";
import { richAbc } from "../../unit/codegen/rich-abc.ts";
import type { Results } from "../suite.ts";
import { count, type FuzzOptions, type Live } from "./common.ts";
import { seedsInModes } from "./handlers.ts";

function typed(code: number[], extra: { method?: Method; traits?: Trait[] } = {}): Uint8Array {
  return abc(
    {
      floats: [0.1, 2.5],
      ints: [3],
      doubles: [1.5],
      strings: ["float", "", "Number", "int", "Vector", "__AS3__.vec", "x", "String"],
      namespaces: [
        [0x16, 2],
        [0x16, 6],
      ],
      multinames: [
        [7, 1, 1],
        [7, 1, 3],
        [7, 1, 4],
        [7, 2, 5],
        [0x1d, 4, 1, 1],
        [7, 1, 7],
        [7, 1, 8],
      ],
    },
    tables({
      methods: [{ params: [1, 2, 3], ret: 1, ...(extra.method ?? {}) }, {}],
      scripts: [{ init: 1, traits: extra.traits ?? [] }],
      bodies: [
        { method: 0, localCount: 6, maxStack: 4, code },
        { method: 1, code: [0xd0, 0x30, 0x47], maxStack: 1, localCount: 1, maxScopeDepth: 1 },
      ],
    }),
  );
}

const ops = {
  getlocal1: [0xd1],
  getlocal2: [0xd2],
  getlocal3: [0xd3],
  setlocal: (n: number) => [0x63, n],
  pushfloat: (n: number) => [0x22, n],
  add: [0xa0],
  sub: [0xa1],
  mul: [0xa2],
  div: [0xa3],
  neg: [0x90],
  inc: [0x91],
  convert_f: [0x79],
  convert_d: [0x75],
  convert_i: [0x73],
  coerce: (n: number) => [0x80, n],
  dup: [0x2a],
  pop: [0x29],
  ret: [0x48],
  pushdouble: (n: number) => [0x2f, n],
  pushint: (n: number) => [0x2d, n],
  lt: [0xad],
  eq: [0xab],
  not: [0x96],
  coerce_a: [0x82],
  unplus: [0xaa],
};

const programs: number[][] = [
  [...ops.getlocal1, ...ops.pushfloat(1), ...ops.add, ...ops.convert_f, ...ops.ret],
  [
    ...ops.getlocal1,
    ...ops.getlocal1,
    ...ops.mul,
    ...ops.pushfloat(2),
    ...ops.sub,
    ...ops.convert_f,
    ...ops.dup,
    ...ops.setlocal(4),
    ...ops.ret,
  ],
  [...ops.getlocal1, ...ops.getlocal2, ...ops.add, ...ops.convert_f, ...ops.ret],
  [...ops.getlocal1, ...ops.getlocal3, ...ops.div, ...ops.convert_d, ...ops.convert_f, ...ops.ret],
  [...ops.getlocal2, ...ops.convert_f, ...ops.neg, ...ops.inc, ...ops.convert_f, ...ops.ret],
  [
    ...ops.getlocal1,
    ...ops.pushdouble(1),
    ...ops.lt,
    ...ops.pop,
    ...ops.getlocal1,
    ...ops.pushint(1),
    ...ops.eq,
    ...ops.pop,
    ...ops.getlocal1,
    ...ops.ret,
  ],
  [...ops.pushfloat(1), ...ops.pushfloat(2), ...ops.add, ...ops.coerce(1), ...ops.ret],
  [
    ...ops.getlocal1,
    ...ops.coerce_a,
    ...ops.pushfloat(1),
    ...ops.add,
    ...ops.coerce(1),
    ...ops.ret,
  ],
  [
    ...ops.getlocal3,
    ...ops.convert_i,
    ...ops.getlocal1,
    ...ops.mul,
    ...ops.convert_f,
    ...ops.setlocal(5),
    0x62,
    5,
    ...ops.ret,
  ],
  [...ops.getlocal1, ...ops.unplus, ...ops.convert_f, ...ops.ret],
  [
    ...ops.getlocal1,
    ...ops.not,
    ...ops.pop,
    ...ops.pushfloat(1),
    ...ops.convert_d,
    ...ops.coerce(1),
    ...ops.ret,
  ],
];

function floatSeeds(): Uint8Array[] {
  const seeds: Uint8Array[] = [
    new Uint8Array(readFileSync(new URL("../../player/fixtures/AirFloat.abc", import.meta.url))),
    richAbc(true),
  ];
  for (const code of programs) {
    seeds.push(typed(code));
    // A float default, and a double default for a typed parameter.
    seeds.push(typed(code, { method: { optional: [[1, 0x02]] } }));
    seeds.push(typed(code, { method: { optional: [[1, 0x06]] } }));
    // A float slot with a default, and a Vector.<float> slot.
    seeds.push(
      typed(code, {
        traits: [
          { name: 6, kind: 0, index: 1, value: 1, valueKind: 0x02 },
          { name: 7, kind: 0, index: 5 },
        ],
      }),
    );
  }

  return seeds;
}

export async function floats(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const seeds = floatSeeds();
  await seedsInModes(
    live,
    r,
    o,
    "floats",
    seeds,
    Math.max(0, count(o, 5000, 5000) - seeds.length * 3),
  );
}
