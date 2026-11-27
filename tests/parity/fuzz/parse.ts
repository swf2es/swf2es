// Parsing, from a review of the idiomatic pass: ABCs cut short at every
// byte, hostile values written over and into them, random edits, and the
// owners of traits and initializers in every combination a parser checks;
// each dumped as a user ABC and as a builtin, its pool dumped, and added to
// a domain.

import { structuredAbcs } from "../../fuzz/bodies.ts";
import { abc, type Tables, tables, u30 } from "../../unit/codegen/abc-builder.ts";
import { linkAbcs } from "../../unit/codegen/link-abc.ts";
import { richAbc } from "../../unit/codegen/rich-abc.ts";
import { verifyErrorAbcs } from "../../unit/codegen/verify-errors.ts";
import type { Compiler, Results } from "../suite.ts";
import {
  count,
  type FuzzOptions,
  generator,
  type Live,
  oracleInputs,
  oracleSeeds,
} from "./common.ts";

/**
 * What the parser makes of `bytes`, each part on its own so that one that
 * throws hides none of the others: dumped as a user ABC and as a builtin,
 * its pool, and added to a domain.
 */
const parsing = (bytes: Uint8Array): ((t: Compiler) => string)[] => [
  (t) => t.abcDump(bytes, false),
  (t) => t.abcDump(bytes, true),
  (t) => t.poolDump(bytes),
  (t) => {
    t.domainReset(50);
    return String(t.domainAdd(bytes, false));
  },
];

const HOSTILE = [
  [0xff, 0xff, 0xff, 0xff, 0x03],
  [0xff, 0xff, 0xff, 0xff, 0x0f],
  [0x80, 0x80, 0x80, 0x80, 0x00],
  [0xff, 0x7f],
  [0x7f],
  [0x00],
  [0x01],
  [0xff, 0xff, 0x03],
];
const EDGES = [0, 1, 0x7f, 0x80, 0xff, 0xfe, 0x3f, 0x40];

export async function parseDumps(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const { random, below } = generator(o.seed);
  const oracle = oracleSeeds(2, 6000, 150);
  const seeds: Uint8Array[] = [
    richAbc(true),
    richAbc(false),
    ...verifyErrorAbcs().map(([, b]) => b),
    ...(Object.values(linkAbcs()) as Uint8Array[]),
    ...structuredAbcs(20, 1),
    ...oracle,
  ];
  // Every truncation and, for small seeds, hostile values at every byte, over and before it; --deep
  // takes every seed under 1,500 bytes, the standard run the first 40.
  const systematic = seeds.filter((s) => s.length <= 1500).slice(0, o.deep ? undefined : 40);
  oracleInputs(r, `${seeds.length} seeds, ${systematic.length} cut and overwritten`, oracle);
  for (const [i, seed] of systematic.entries()) {
    for (let n = 0; n < seed.length; n++) {
      await live.parts(r, `cut ${i} ${n}`, parsing(seed.subarray(0, n)));
    }

    for (let p = 4; p < seed.length; p++) {
      for (const [h, bytes] of HOSTILE.entries()) {
        const replaced = new Uint8Array([
          ...seed.subarray(0, p),
          ...bytes,
          ...seed.subarray(p + 1),
        ]);
        await live.parts(r, `replace ${i} ${p} ${h}`, parsing(replaced));
        if (h < 3) {
          const inserted = new Uint8Array([...seed.subarray(0, p), ...bytes, ...seed.subarray(p)]);
          await live.parts(r, `insert ${i} ${p} ${h}`, parsing(inserted));
        }
      }
    }
  }

  // Random edits, insertions, cuts and copies.
  const total = count(o, 20000, 20000);
  for (let c = 0; c < total; c++) {
    let bytes = [...seeds[below(seeds.length)]];
    const edits = 1 + below(4);
    for (let m = 0; m < edits; m++) {
      const n = bytes.length;
      if (!n) {
        break;
      }

      const at = random() < 0.5 ? below(n) : n - 1 - below(Math.min(n, 200));
      switch (below(7)) {
        case 0:
          bytes[at] ^= 1 << below(8);
          break;
        case 1:
          bytes[at] = EDGES[below(EDGES.length)];
          break;
        case 2:
          bytes.splice(at, 0, ...HOSTILE[below(HOSTILE.length)]);
          break;
        case 3:
          bytes.splice(at, 1 + below(4));
          break;
        case 4:
          bytes = bytes.slice(0, at);
          break;
        case 5:
          bytes.splice(at, 1, ...HOSTILE[below(3)]);
          break;
        default: {
          const from = below(n);
          bytes.splice(at, 0, ...bytes.slice(from, from + 1 + below(16)));
        }
      }
    }

    const edited = new Uint8Array(bytes);
    await live.parts(r, `random ${c}`, parsing(edited));
  }
}

const names = ["a", "b", "c", "d"];
const ownersPool = {
  strings: ["", ...names],
  namespaces: [[0x16, ...u30(1)]],
  multinames: names.map((_, i) => [0x07, ...u30(1), ...u30(i + 2)]),
};
const M = 1;
const G = 2;
const S = 3;
const CLS = 4;
const SLOT = 0;

/** The owners of traits and initializers, in every way a parser has to tell apart. */
function ownerCases(): [string, Uint8Array][] {
  const methods = Array.from({ length: 8 }, () => ({}));
  const m = (name: number, index: number, kind = M, extra: object = {}) => ({
    name,
    kind,
    index,
    ...extra,
  });
  const cls = (it: object[], ct: object[], iinit = 6, cinit = 7) => [
    { instance: { name: 1, init: iinit, traits: it }, init: cinit, traits: ct },
  ];
  const T = (t: object) =>
    abc(ownersPool, tables({ methods, metadata: [{ name: 1 }], ...t } as Tables));
  return Object.entries({
    within: T({ scripts: [{ init: 0, traits: [m(1, 1), m(2, 1)] }] }),
    withinGetSet: T({ scripts: [{ init: 0, traits: [m(1, 1, G), m(1, 1, S)] }] }),
    across: T({ classes: cls([m(1, 1)], [m(1, 1)]), scripts: [{ init: 0 }] }),
    acrossScript: T({ classes: cls([m(1, 1)], []), scripts: [{ init: 0, traits: [m(2, 1)] }] }),
    dupThenBadName: T({ scripts: [{ init: 0, traits: [m(1, 1), m(2, 1), m(99, 2)] }] }),
    dupThenName0: T({ scripts: [{ init: 0, traits: [m(1, 1), m(2, 1), m(0, 2)] }] }),
    dupThenBadKind: T({ scripts: [{ init: 0, traits: [m(1, 1), m(2, 1), m(3, 2, 7)] }] }),
    dupThenMethodRange: T({ scripts: [{ init: 0, traits: [m(1, 1), m(2, 1), m(3, 50)] }] }),
    dupThenClassRange: T({ scripts: [{ init: 0, traits: [m(1, 1), m(2, 1), m(3, 50, CLS)] }] }),
    dupThenClassOrder: T({
      classes: cls([m(1, 1), m(2, 1), m(3, 0, CLS)], []),
      scripts: [{ init: 0 }],
    }),
    dupThenBadMetadata: T({
      scripts: [{ init: 0, traits: [m(1, 1), m(2, 1), m(3, 2, M, { metadata: [9] })] }],
    }),
    rangeThenDup: T({ scripts: [{ init: 0, traits: [m(1, 50), m(2, 1), m(3, 1)] }] }),
    dupThenOk: T({
      scripts: [{ init: 0, traits: [m(1, 1), m(2, 1), m(3, 2), { name: 4, kind: SLOT }] }],
    }),
    tripleAndOthers: T({
      scripts: [{ init: 0, traits: [m(1, 1), m(2, 2), m(3, 1), m(4, 2), m(1, 3)] }],
    }),
    traitIsIinit: T({ classes: cls([m(1, 6)], []), scripts: [{ init: 0 }] }),
    traitIsCinit: T({ classes: cls([], [m(1, 7)]), scripts: [{ init: 0 }] }),
    classTraitIsIinit: T({ classes: cls([], [m(1, 6)]), scripts: [{ init: 0 }] }),
    iinitIsCinit: T({ classes: cls([], [], 6, 6), scripts: [{ init: 0 }] }),
    scriptTraitIsInit: T({ scripts: [{ init: 0, traits: [m(1, 0)] }] }),
    scriptInitOwned: T({ classes: cls([m(1, 0)], []), scripts: [{ init: 0 }] }),
    twoScriptsSameInit: T({ scripts: [{ init: 0 }, { init: 0 }] }),
    secondScriptDup: T({
      scripts: [
        { init: 0, traits: [m(1, 1)] },
        { init: 2, traits: [m(1, 1)] },
      ],
    }),
    bodyTraitDup: T({
      scripts: [{ init: 0, traits: [m(1, 1)] }],
      bodies: [{ method: 0, traits: [m(2, 1)] }],
    }),
    bodyTraitDupWithin: T({
      scripts: [{ init: 0 }],
      bodies: [{ method: 0, traits: [m(2, 3), m(1, 3)] }],
    }),
    bodyTraitOwnsItself: T({ scripts: [{ init: 0 }], bodies: [{ method: 1, traits: [m(2, 1)] }] }),
    bodyDupThenBodyBad: T({
      scripts: [{ init: 0, traits: [m(1, 1)] }],
      bodies: [{ method: 0, traits: [m(2, 1)] }, { method: 99 }],
    }),
    ifaceBodyAfterDup: T({
      classes: [{ instance: { name: 1, init: 6, flags: 4, traits: [m(1, 1)] }, init: 7 }],
      scripts: [{ init: 0, traits: [m(2, 1)] }],
      bodies: [{ method: 1 }],
    }),
    valid: T({
      classes: cls([m(1, 1)], [m(1, 2)]),
      scripts: [{ init: 0, traits: [m(2, 3)] }],
      bodies: [{ method: 0, traits: [{ name: 3, kind: SLOT }] }],
    }),
  });
}

const OWNER_HOSTILE = [
  [0xff, 0xff, 0xff, 0xff, 0x03],
  [0x80, 0x80, 0x80, 0x80, 0x00],
  [0x7f],
  [0],
  [1],
  [2],
  [3],
  [4],
  [5],
  [6],
  [7],
  [8],
  [0x11],
  [0x41],
  [0x42],
];

export async function parseOwners(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const cases = ownerCases();
  r.input(`${cases.length} owners' ABCs`);
  for (const [label, bytes] of cases) {
    await live.parts(r, label, parsing(bytes));
    for (let n = 0; n < bytes.length; n++) {
      await live.parts(r, `${label} cut ${n}`, parsing(bytes.subarray(0, n)));
    }

    for (let p = 4; p < bytes.length; p++) {
      for (const h of OWNER_HOSTILE) {
        const replaced = new Uint8Array([...bytes.subarray(0, p), ...h, ...bytes.subarray(p + 1)]);
        await live.parts(r, `${label} replace ${p} ${h}`, parsing(replaced));
      }
    }

    // Pairs of single-byte changes in the tables after the pool, the last 40 bytes: --deep only.
    if (!o.deep) {
      continue;
    }

    const from = Math.max(4, bytes.length - 40);
    for (let p = from; p < bytes.length; p++) {
      for (let q = p + 1; q < bytes.length; q++) {
        for (const a of [0, 1, 2, 6, 7]) {
          for (const b of [0, 1, 2, 6, 50]) {
            const changed = bytes.slice();
            changed[p] = a;
            changed[q] = b;
            await live.parts(r, `${label} pair ${p} ${q} ${a} ${b}`, parsing(changed));
          }
        }
      }
    }
  }
}
