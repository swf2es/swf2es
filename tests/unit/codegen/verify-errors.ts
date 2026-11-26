// ABCs that reach the VerifyErrors the other suites do not: 1008, a name
// bound in two namespaces of the set it is read with, and 1035, getsuper in
// a function, which no class declares; and one that verifies with what the
// rollback tests need to fail allocations in: a function created in two
// scope chains, contested and settled, a handler with a catch scope, and a
// switch of many cases.
import { abc, tables, u30 } from "./abc-builder.ts";

export function verifyErrorAbcs(): [string, Uint8Array][] {
  const pool = {
    strings: ["", "Object", "C", "x", "A", "m", "f"],
    namespaces: [
      [0x16, ...u30(1)],
      [0x16, ...u30(5)],
    ],
    nsSets: [[1, 2]],
    multinames: [
      [0x07, 1, 2],
      [0x07, 1, 3],
      [0x07, 1, 4],
      [0x07, 2, 4],
      [0x09, 4, 1],
      [0x07, 1, 6],
      [0x07, 1, 7],
    ],
  };
  // Script: C created with Object on the scope chain, then function 4.
  const script = [
    0xd0, 0x30, 0xd0, 0x60, 1, 0x30, 0x60, 1, 0x58, 0, 0x1d, 0x68, 2, 0x40, 4, 0x29, 0x47,
  ];
  const make = (
    method: number[],
    fn: number[],
    exceptions: [number, number, number, number, number][] = [],
  ) =>
    abc(
      pool,
      tables({
        methods: [{}, {}, {}, {}, {}],
        classes: [
          {
            instance: {
              name: 2,
              base: 1,
              init: 1,
              traits: [
                { name: 3, kind: 0 },
                { name: 4, kind: 0 },
                { name: 6, kind: 1, index: 3 },
              ],
            },
            init: 2,
          },
        ],
        scripts: [{ init: 0, traits: [{ name: 2, kind: 4, id: 1, index: 0 }] }],
        bodies: [
          { method: 0, maxStack: 3, localCount: 1, maxScopeDepth: 3, code: script },
          { method: 1, maxStack: 1, localCount: 1, maxScopeDepth: 1, code: [0xd0, 0x30, 0x47] },
          { method: 2, code: [0x47] },
          { method: 3, maxStack: 2, localCount: 1, maxScopeDepth: 2, code: method, exceptions },
          { method: 4, maxStack: 2, localCount: 1, maxScopeDepth: 1, code: fn },
        ],
      }),
    );
  return [
    // C.m reads x through {public, A}, which binds it in both: 1008.
    ["ambiguous x", make([0xd0, 0x66, 5, 0x48], [0x47])],
    // Function f calls getsuper: 1035.
    ["getsuper in a function", make([0xd0, 0x30, 0x47], [0xd0, 0x04, 3, 0x48])],
    // C.m creates f in its chain too, under a handler naming x, through a switch of 20 cases.
    ["contested, caught, switched", make(contested().code, [0x47], [contested().handler])],
  ];
}

/**
 * C.m: f created in its scope chain, then under a handler a name looked up,
 * which may throw, and a switch of 20 cases; the handler makes a catch scope.
 */
function contested(): { code: number[]; handler: [number, number, number, number, number] } {
  const code = [0xd0, 0x30, 0x40, 4, 0x29];
  const from = code.length;
  code.push(0x5d, 3, 0x29, 0x24, 1);
  const at = code.length;
  const cases = 20;
  const end = at + 1 + 3 + 1 + 3 * cases;
  const s24 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
  code.push(0x1b, ...s24(end - at), cases - 1);
  for (let k = 0; k < cases; k++) {
    code.push(...s24(end - at));
  }

  // The try ends at the returnvoid; the handler pushes its catch scope's object and drops it.
  code.push(0x47, 0x5a, 0, 0x29, 0x29, 0x47);
  return { code, handler: [from, end, end + 1, 0, 3] };
}
