// Linking's rejections, from a review of the idiomatic pass: every type a
// class's base, interface, slot, parameter, result, default, coercion or
// catch can name, alone and in pairs, then mutated near the end, with and
// without the libraries and float's; each linked case resolved, verified,
// compiled and dumped.
import {
  abc,
  type Body,
  type Method,
  type Pool,
  type Trait,
  tables,
} from "../../unit/codegen/abc-builder.ts";
import type { Results } from "../suite.ts";
import {
  builtin,
  count,
  type FuzzOptions,
  float,
  generator,
  hashes,
  type Live,
  shell,
} from "./common.ts";

const pool: Pool = {
  ints: [7],
  doubles: [1.5],
  strings: [
    "",
    "void",
    "Object",
    "int",
    "Vector",
    "__AS3__.vec",
    "Missing",
    "a",
    "b",
    "X",
    "C",
    "D",
    "String",
    "s",
    "m",
    "IFace",
    "Error",
    "Class",
    "Number",
    "s2",
  ],
  namespaces: [
    [0x16, 1],
    [0x16, 6],
    [0x16, 8],
    [0x16, 9],
  ],
  nsSets: [
    [3, 4],
    [1, 2],
  ],
  multinames: [
    [7, 1, 2],
    [7, 1, 3],
    [7, 1, 4],
    [7, 2, 5],
    [7, 1, 7],
    [7, 3, 10],
    [7, 4, 10],
    [9, 10, 1],
    [7, 1, 11],
    [7, 1, 12],
    [7, 1, 13],
    [7, 1, 14],
    [7, 1, 15],
    [0x1d, 4, 1, 3],
    [0x1d, 4, 1, 1],
    [0x1d, 4, 1, 5],
    [0x1d, 5, 1, 3],
    [0x1d, 2, 1, 3],
    [0x1d, 1, 1, 3],
    [0x1d, 8, 1, 3],
    [0x1d, 4, 1, 8],
    [0x1d, 4, 1, 14],
    [0x1d, 4, 1, 15],
    [0x1d, 4, 1, 17],
    [0x1d, 4, 1, 9],
    [0x1d, 4, 1, 0],
    [7, 1, 17],
    [7, 1, 19],
    [7, 1, 16],
    [7, 1, 20],
  ],
};

/** The multinames a type is named by: none, the builtins, Vectors of them, missing ones and bad indices. */
const TYPES = [
  0, 1, 2, 3, 5, 8, 9, 11, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 6,
];

interface Shape {
  base?: number;
  iface?: number;
  slot?: number;
  slot2?: number;
  slotValue?: [number, number];
  params?: number[];
  ret?: number;
  optional?: [number, number][];
  op?: [number, number];
  catchType?: number;
  ifaceIsInterface?: boolean;
  final?: boolean;
}

function build(x: Shape): Uint8Array {
  const init = [0xd0, 0x30, 0x47];
  // pushnull, coerce, astype or istype a type, pop
  const code = x.op ? [0x20, x.op[0], x.op[1], 0x29, 0x47] : [0x47];
  const methods: Method[] = [
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    { params: x.params ?? [], ret: x.ret ?? 0, ...(x.optional ? { optional: x.optional } : {}) },
    {},
    {},
  ];
  const bodies: Body[] = [0, 1, 2, 3, 4, 5, 6, 8, 9].map((m) => ({
    method: m,
    code: init,
    maxStack: 1,
    localCount: 1,
    maxScopeDepth: 1,
  }));
  bodies.push({
    method: 7,
    code,
    maxStack: 2,
    localCount: 1 + (x.params?.length ?? 0),
    exceptions:
      x.catchType !== undefined ? [[0, code.length - 1, code.length - 1, x.catchType, 12]] : [],
  });
  const traits: Trait[] = [{ name: 13, kind: 1, index: 7 }];
  if (x.slot !== undefined) {
    traits.push({
      name: 12,
      kind: 0,
      index: x.slot,
      ...(x.slotValue ? { value: x.slotValue[0], valueKind: x.slotValue[1] } : {}),
    });
  }

  if (x.slot2 !== undefined) {
    traits.push({ name: 30, kind: 0, index: x.slot2 });
  }

  return abc(
    pool,
    tables({
      methods,
      classes: [
        { instance: { name: 6, base: 2, init: 3, flags: x.final ? 2 : 0 }, init: 4 },
        { instance: { name: 7, base: 2, init: 5 }, init: 6 },
        {
          instance: {
            name: 29,
            base: x.ifaceIsInterface ? 0 : 2,
            init: 8,
            flags: x.ifaceIsInterface ? 4 : 0,
          },
          init: 9,
        },
        {
          instance: {
            name: 9,
            base: x.base ?? 2,
            init: 1,
            interfaces: x.iface !== undefined ? [x.iface] : [],
          },
          init: 2,
        },
      ],
      scripts: [{ init: 0, traits }],
      bodies,
    }),
  );
}

function shapes(): Shape[] {
  const all: Shape[] = [];
  for (const t of TYPES) {
    all.push(
      { base: t },
      { iface: t },
      { iface: t, ifaceIsInterface: true },
      { slot: t },
      { slot: t, slotValue: [1, 0x03] },
      { slot: t, slotValue: [1, 0x06] },
      { slot: t, slotValue: [1, 0x0c] },
      { slot: t, slotValue: [9, 0x03] },
      { params: [t] },
      { ret: t },
      { params: [t], optional: [[1, 0x03]] },
      { params: [t], optional: [[1, 0x01]] },
      {
        params: [3, t],
        optional: [
          [1, 0x06],
          [1, 0x0a],
        ],
      },
      { op: [0x80, t] },
      { op: [0x86, t] },
      { op: [0xb2, t] },
      { catchType: t },
      { base: t, final: true },
    );
    for (const u of TYPES) {
      all.push(
        { base: t, iface: u },
        { params: [t, u] },
        { params: [t], ret: u },
        { slot: t, slot2: u },
        { slot: t, params: [u] },
        { catchType: t, op: [0x80, u] },
      );
    }
  }

  return all;
}

export async function reject(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const { random, below } = generator(o.seed);
  const all = shapes();
  const mutate = (a: Uint8Array): Uint8Array => {
    const bytes = [...a];
    const n = 1 + below(3);
    for (let m = 0; m < n; m++) {
      const at = bytes.length - 1 - below(Math.min(bytes.length, 170));
      switch (below(3)) {
        case 0:
          bytes[at] ^= 1 << below(5);
          break;
        case 1:
          bytes[at] = below(31);
          break;
        default:
          bytes[at] = (bytes[at] + (random() < 0.5 ? 1 : 255)) & 255;
      }
    }

    return new Uint8Array(bytes);
  };
  // Every shape in two of its modes in --deep; every fourth else.
  const step = o.deep ? 1 : 4;
  const systematic: [Shape, number][] = [];
  for (let mode = 0; mode < 2; mode++) {
    for (let i = 0; i < all.length; i += step) {
      systematic.push([all[i], mode]);
    }
  }

  const total = systematic.length + count(o, 3000, 3000);
  for (let c = 0; c < total; c++) {
    const isSystematic = c < systematic.length;
    const [shape, systematicMode] = isSystematic ? systematic[c] : [all[below(all.length)], 0];
    const original = build(shape);
    const bytes = isSystematic ? original : mutate(original);
    // 0: the libraries; 1: none; 2: the libraries and float's.
    const mode = isSystematic ? systematicMode : below(3);
    const libraries = mode === 0 ? [builtin, shell] : mode === 2 ? [builtin, shell, float] : [];
    await live.case(r, `reject ${c}`, (t) => {
      t.domainReset(50);
      for (const library of libraries) {
        t.domainAdd(library, true);
      }

      const added = t.domainAdd(bytes, false);
      let text = `add ${added}\n${t.domainSummary()}`;
      if (added === 0) {
        // Resolved in two orders: as the verifier needs it, or every traits from the first.
        if (c % 2) {
          text += `\nresolve ${t.domainResolve(0)}`;
        }

        text += `\n${t.domainVerifyAll()}\n${t.domainModule(hashes(libraries, bytes))}\n${t.domainIrAll()}\nresolve ${t.domainResolve(0)}\n${t.domainSummary()}`;
      } else {
        const again = t.domainAdd(build({}), false);
        text += `\nthen ${again}\n${t.domainSummary()}`;
      }

      return text;
    });
  }
}
