// Method bodies, from a review of the idiomatic pass: ABCs that link, their
// bodies' code mutated where an opcode or an operand is, with the
// libraries, float's, and at API version 12; each linked case verified,
// compiled and dumped. The seeds are the tests' ABCs, structured bodies,
// exception handlers and, where the oracle's cache has them, compiled
// tests'; those that link, and their bodies' ranges, as the compiler under
// test dumps them.
import { structuredAbcs } from "../../fuzz/bodies.ts";
import { linkAbcs } from "../../unit/codegen/link-abc.ts";
import { richAbc } from "../../unit/codegen/rich-abc.ts";
import type { Compiler, Results } from "../suite.ts";
import {
  builtin,
  compiled,
  count,
  type FuzzOptions,
  float,
  generator,
  type Live,
  oracleSeeds,
  shell,
} from "./common.ts";
import { handlerSeeds } from "./handlers.ts";

/** Opcodes worth landing on: every range of the table, weighted to those the verifier types. */
const OPS = [
  0x02, 0x03, 0x04, 0x05, 0x06, 0x08, 0x09, 0x0c, 0x0d, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x1b,
  0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b,
  0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x4c, 0x4e, 0x4f, 0x53, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5d, 0x5e, 0x5f, 0x60,
  0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x68, 0x6a, 0x6c, 0x6d, 0x6e, 0x6f, 0x70, 0x71, 0x72, 0x73,
  0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x90, 0x91, 0x92,
  0x93, 0x94, 0x95, 0x96, 0x97, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
  0xab, 0xac, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xef, 0xf0, 0xf1, 0x01, 0x07, 0x0a,
  0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x50, 0x51, 0x52, 0xff, 0xfe,
];

interface Seed {
  bytes: Uint8Array;
  ranges: [number, number][];
}

/** The seeds that link after the libraries, and their bodies' code, as `t` dumps them. */
async function linking(live: Live, candidates: Uint8Array[]): Promise<Seed[]> {
  const seeds: Seed[] = [];
  for (const bytes of candidates) {
    let dump = "";
    try {
      const t: Compiler = live.c;
      t.domainReset(50);
      t.domainAdd(builtin, true);
      t.domainAdd(shell, true);
      if (t.domainAdd(bytes, false) !== 0) {
        continue;
      }

      dump = t.abcDump(bytes, false);
    } catch {
      live.c = await live.fresh();
      continue;
    }

    const ranges: [number, number][] = [];
    for (const m of dump.matchAll(/code=(\d+)\+(\d+)/g)) {
      ranges.push([Number(m[1]), Number(m[2])]);
    }

    if (ranges.length) {
      seeds.push({ bytes, ranges });
    }
  }

  return seeds;
}

export async function bodies(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const { random, below } = generator(o.seed);
  const handlers = handlerSeeds().filter((_, i) => i >= 2 && i % 3 === 0);
  const candidates = [
    richAbc(true),
    richAbc(false),
    ...(Object.values(linkAbcs()) as Uint8Array[]),
    ...structuredAbcs(60, 1),
    ...structuredAbcs(40, 7),
    ...handlers,
    ...oracleSeeds(4, 30000, 700),
  ];
  const seeds = await linking(live, candidates);
  r.case("bodies seeds", () => `${seeds.length} of ${candidates.length}`);
  const mutate = (x: Seed): Uint8Array => {
    const bytes = x.bytes.slice();
    const n = 1 + below(3);
    for (let m = 0; m < n; m++) {
      const [start, len] = x.ranges[below(x.ranges.length)];
      const at = start + below(len);
      switch (below(5)) {
        case 0:
        case 1:
          bytes[at] = OPS[below(OPS.length)];
          break;
        case 2:
          // A small operand.
          bytes[at] = below(12);
          break;
        case 3:
          bytes[at] = (bytes[at] + (random() < 0.5 ? 1 : 255)) & 255;
          break;
        default:
          bytes[at] ^= 1 << below(8);
      }
    }

    return bytes;
  };
  const total = count(o, 3000, 3000);
  for (let c = 0; c < total; c++) {
    const bytes = mutate(seeds[below(seeds.length)]);
    // 0-1: the libraries; 2: with float's; 3: at API version 12.
    const mode = c % 4;
    const libraries = mode === 2 ? [builtin, shell, float] : [builtin, shell];
    await live.case(r, `bodies ${c}`, (t) =>
      compiled(t, bytes, libraries, mode === 3 ? 12 : 50, false),
    );
  }
}
