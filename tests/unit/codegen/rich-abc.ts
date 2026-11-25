// A hand-built ABC with something of every kind the parser reads: pools of
// every kind (floats in the 47.16 one), namespaces of every kind, sets,
// multinames of every kind TypeNames included, methods with optional
// values and parameter names, metadata, a class with a protected
// namespace, interfaces and traits of every kind, a script, and bodies
// with exceptions and activation traits: a seed of tests/fuzz/abc.ts, and
// what zig.test.ts checks the Zig tests' copy against.
import { abc, tables, u30 } from "./abc-builder.ts";

export function richAbc(floats: boolean): Uint8Array {
  const pool = {
    ints: [1, -5 >>> 0, 0x7fffffff],
    uints: [7, 0xffffffff],
    doubles: [0.1, 1e300, -0],
    ...(floats ? { floats: [0.5, 16777216] } : {}),
    strings: ["x", "", "héllo", "Vector", "ns", "y", "z"],
    namespaces: [
      [0x16, ...u30(1)],
      [0x08, ...u30(5)],
      [0x05, ...u30(0)],
      [0x17, ...u30(2)],
      [0x18, ...u30(5)],
      [0x19, ...u30(5)],
      [0x1a, ...u30(5)],
    ],
    nsSets: [[1], [1, 2, 3], [4]],
    multinames: [
      [0x07, 1, 1],
      [0x0d, 1, 6],
      [0x0f, 1],
      [0x10, 1],
      [0x11],
      [0x12],
      [0x09, 1, 1],
      [0x0e, 7, 2],
      [0x1b, 1],
      [0x1c, 3],
      [0x1d, 1, 1, 2],
      [0x1d, 1, 1, 11],
      [0x07, 1, 6],
      [0x07, 1, 7],
    ],
  };
  return abc(
    pool,
    tables({
      methods: [
        {},
        {
          params: [1, 2],
          ret: 1,
          name: 1,
          optional: [
            [1, 3],
            [2, 6],
          ],
          paramNames: [1, 2],
        },
        { params: [0] },
        {},
        {},
        {},
        {},
      ],
      metadata: [
        {
          name: 1,
          items: [
            [1, 2],
            [0, 3],
          ],
        },
        { name: 2 },
      ],
      classes: [
        {
          instance: {
            name: 1,
            base: 13,
            flags: 0,
            protectedNs: 2,
            interfaces: [13, 14],
            init: 2,
            traits: [
              { kind: 0, name: 13, id: 1, index: 1, value: 1, valueKind: 3, metadata: [0, 1] },
              { kind: 6, name: 14, id: 2 },
              { kind: 1, name: 1, index: 3 },
            ],
          },
          init: 4,
          traits: [{ kind: 2, name: 13, index: 5 }],
        },
      ],
      scripts: [
        {
          init: 0,
          traits: [
            { kind: 4, name: 1, id: 1, index: 0 },
            { kind: 3, name: 14, index: 6 },
          ],
        },
      ],
      bodies: [
        {
          method: 0,
          code: [0xd0, 0x30, 0x47],
          exceptions: [
            [0, 1, 2, 1, 13],
            [0, 2, 2, 0, 0],
          ],
        },
        { method: 1, traits: [{ kind: 0, name: 13, id: 1 }] },
        { method: 2 },
      ],
    }),
  );
}
