// Exception handlers, from a review of the idiomatic pass: bodies with many
// handlers, typed and untyped, nested or one after another, of different
// counts from body to body, as they are and mutated, with the libraries,
// without float's, and with none; each linked case verified, compiled and
// dumped.
import { abc, type Body, type Pool, tables } from "../../unit/codegen/abc-builder.ts";
import { richAbc } from "../../unit/codegen/rich-abc.ts";
import type { Results } from "../suite.ts";
import {
  builtin,
  compiled,
  count,
  type FuzzOptions,
  float,
  generator,
  type Live,
  shell,
} from "./common.ts";

const pool: Pool = {
  strings: [
    "Error",
    "",
    "Object",
    "int",
    "e",
    "Missing",
    "String",
    "x",
    "m0",
    "m1",
    "m2",
    "m3",
    "m4",
    "m5",
    "m6",
    "m7",
  ],
  namespaces: [[0x16, 2]],
  multinames: [
    [7, 1, 1],
    [7, 1, 3],
    [7, 1, 4],
    [7, 1, 5],
    [7, 1, 6],
    [7, 1, 7],
    [7, 1, 8],
    ...Array.from({ length: 8 }, (_, i) => [7, 1, 9 + i]),
  ],
};

interface Options {
  types: number[];
  nested: boolean;
  names: boolean;
  code?: number;
}

/** One body: `count` handlers over nested ranges or one after another, each with its own target, which makes its catch scope. */
function body(method: number, count: number, opts: Options): Body {
  const code: number[] = [0xd0, 0x30];
  const starts: number[] = [];
  const ends: number[] = [];
  // pushbyte 1, pop, getlocal0, pop
  const work = [0x24, 1, 0x29, 0xd0, 0x29];
  if (opts.nested) {
    for (let k = 0; k < count; k++) {
      starts.push(code.length);
      code.push(...work);
    }

    for (let k = 0; k < count; k++) {
      code.push(...work);
      ends[count - 1 - k] = code.length;
    }
  } else {
    for (let k = 0; k < count; k++) {
      starts.push(code.length);
      code.push(...work, ...(opts.code ? [opts.code] : []));
      ends.push(code.length);
    }
  }

  code.push(0x47);
  const exceptions: [number, number, number, number, number][] = [];
  for (let k = 0; k < count; k++) {
    const target = code.length;
    // The exception on the stack: newcatch k, dup, setlocal 1, pop the scope, pop the exception or keep it in a local, returnvoid.
    code.push(0x5a, k, 0x2a, 0x63, 1, 0x29, 0x63, 2, 0x47);
    exceptions.push([
      starts[k],
      ends[k],
      target,
      opts.types[k % opts.types.length],
      opts.names ? 5 : 0,
    ]);
  }

  return { method, maxStack: 3, localCount: 3, maxScopeDepth: 2, code, exceptions };
}

function program(counts: number[], opts: Options): Uint8Array {
  const methods = counts.map(() => ({}));
  return abc(
    pool,
    tables({
      methods: [...methods, {}],
      scripts: [
        { init: counts.length, traits: counts.map((_, i) => ({ name: 8 + i, kind: 1, index: i })) },
      ],
      bodies: [
        ...counts.map((n, i) => body(i, n, opts)),
        {
          method: counts.length,
          code: [0xd0, 0x30, 0x47],
          maxStack: 1,
          localCount: 1,
          maxScopeDepth: 1,
        },
      ],
    }),
  );
}

/** The seeds: the rich ABCs, then programs of every shape of handlers, typed by each set of types. */
export function handlerSeeds(): Uint8Array[] {
  const seeds: Uint8Array[] = [richAbc(true), richAbc(false)];
  const shapes = [
    [12, 0, 3, 30, 1],
    [1, 40, 2, 0, 40, 5],
    [60, 1],
    [0, 0, 7],
    [3, 3, 3, 3],
    [100, 2, 50, 1, 0, 25],
    [5, 4, 3, 2, 1, 0],
    [2, 120],
  ];
  // 6 names a class that is missing; 4 a slot's name, no class; 7 String.
  const typeSets = [[0], [1], [1, 2, 3], [1, 0, 2, 0, 3], [1, 6, 2], [7], [4]];
  for (const counts of shapes) {
    for (const types of typeSets) {
      for (const nested of [false, true]) {
        seeds.push(program(counts, { types, nested, names: true }));
        if (types.length > 2) {
          seeds.push(program(counts, { types, nested, names: false }));
        }

        if (!nested && types.length === 3) {
          // A throw inside each range.
          seeds.push(program(counts, { types, nested, names: true, code: 0x03 }));
        }
      }
    }
  }

  return seeds;
}

/** Bytes worth landing on: small numbers, the opcodes of floats, locals, branches and pushes. */
const EDGES = [
  0, 1, 2, 3, 4, 5, 6, 7, 0x22, 0x79, 0x75, 0x73, 0x80, 0xa0, 0xa3, 0x62, 0x63, 0xd1, 0xd2, 0xd3,
  0x2f, 0x2d, 0x82, 0x48, 0x47, 0x1d, 0x06, 0x0c, 12, 16, 46, 47,
];

/** Up to three bytes changed, most near the end, where the bodies are. */
function nearTheEnd(random: () => number, below: (n: number) => number, a: Uint8Array): Uint8Array {
  const bytes = [...a];
  const n = below(4);
  for (let m = 0; m < n; m++) {
    const at =
      random() < 0.6 ? bytes.length - 1 - below(Math.min(bytes.length, 60)) : below(bytes.length);
    switch (below(4)) {
      case 0:
        bytes[at] ^= 1 << below(8);
        break;
      case 1:
        bytes[at] = EDGES[below(EDGES.length)];
        break;
      case 2:
        bytes[at] = (bytes[at] + (random() < 0.5 ? 1 : 255)) & 255;
        break;
      default:
        bytes[at] = below(256);
    }
  }

  return new Uint8Array(bytes);
}

/**
 * Seeds, each in three modes as it is, then mutated ones: 0 the libraries
 * and float's, 1 the libraries without float's, 2 none.
 */
export async function seedsInModes(
  live: Live,
  r: Results,
  o: FuzzOptions,
  name: string,
  seeds: Uint8Array[],
  mutations: number,
): Promise<void> {
  const { random, below } = generator(o.seed);
  const total = seeds.length * 3 + Math.max(0, mutations);
  r.input(`${seeds.length} seeds`);
  for (let c = 0; c < total; c++) {
    const asIs = c < seeds.length * 3;
    const original = seeds[asIs ? c % seeds.length : below(seeds.length)];
    const bytes = asIs ? original : nearTheEnd(random, below, original);
    const mode = asIs ? Math.floor(c / seeds.length) : below(3);
    const libraries = mode === 0 ? [builtin, shell, float] : mode === 1 ? [builtin, shell] : [];
    await live.case(
      r,
      `${name} ${c}`,
      (t) => `mode ${mode} ${compiled(t, bytes, libraries, 50, true)}`,
    );
  }
}

export async function handlers(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const seeds = handlerSeeds();
  await seedsInModes(
    live,
    r,
    o,
    "handlers",
    seeds,
    Math.max(0, count(o, 5000, 5000) - seeds.length * 3),
  );
}
