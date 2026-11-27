// Linking, from a review of the idiomatic pass: the tests' ABCs and, where
// the oracle's cache has them, compiled tests', mutated anywhere and given
// other versions; linked after the libraries, with float's, with none, as
// a builtin, after a mutated builtin; at API versions 50, 12 and 0. After a
// refused link, the domain as it was, then the seed itself linked into it.
import { structuredAbcs } from "../../fuzz/bodies.ts";
import { linkAbcs } from "../../unit/codegen/link-abc.ts";
import { richAbc } from "../../unit/codegen/rich-abc.ts";
import { verifyErrorAbcs } from "../../unit/codegen/verify-errors.ts";
import type { Results } from "../suite.ts";
import {
  builtin,
  count,
  type FuzzOptions,
  float,
  generator,
  type Live,
  oracleInputs,
  oracleSeeds,
  sha,
  shell,
} from "./common.ts";

const EDGES = [0, 1, 2, 4, 8, 0x10, 0x20, 0x40, 0x7f, 0x80, 0xff, 0xfe, 0x3f, 0xc0, 0x18, 0x0d];
const VERSIONS = [50, 50, 50, 12, 50, 50, 50, 0];

export async function link(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const { random, below } = generator(o.seed);
  const oracle = oracleSeeds(3, 20000, 400);
  const seeds: Uint8Array[] = [
    richAbc(true),
    richAbc(false),
    ...verifyErrorAbcs().map(([, b]) => b),
    ...(Object.values(linkAbcs()) as Uint8Array[]),
    ...structuredAbcs(20, 1),
    ...oracle,
  ];
  oracleInputs(r, `${seeds.length} seeds`, oracle);
  const mutate = (a: Uint8Array): Uint8Array => {
    const bytes = [...a];
    // None: the seed itself.
    const n = below(4);
    for (let m = 0; m < n; m++) {
      const at = below(bytes.length);
      switch (below(5)) {
        case 0:
          bytes[at] ^= 1 << below(8);
          break;
        case 1:
          bytes[at] = EDGES[below(EDGES.length)];
          break;
        case 2:
          bytes[at] = below(256);
          break;
        case 3:
          bytes[at] = (bytes[at] + (random() < 0.5 ? 1 : 255)) & 255;
          break;
        default:
          bytes[at] ^= 0x80 | (1 << below(8));
      }
    }

    if (below(3) === 0) {
      bytes[0] = [12, 16, 17, 18, 15][below(5)];
      bytes[1] = 0;
      bytes[2] = [47, 47, 47, 46][below(4)];
      bytes[3] = 0;
    }

    return new Uint8Array(bytes);
  };
  const total = count(o, 5000, 5000);
  for (let c = 0; c < total; c++) {
    const original = seeds[below(seeds.length)];
    const bytes = mutate(original);
    const keys = [sha(builtin), sha(shell), sha(bytes)].join("\n");
    // 0-3: the libraries first, 2-3 with float's; 4: no libraries (no Object, no Class); 5: the case
    // as a builtin, first; 6: the builtin itself mutated, then the seed; 7: the case as a builtin
    // after the builtin and float's.
    const mode = (c >> 3) % 8;
    const mutatedBuiltin = mode === 6 ? mutate(builtin) : builtin;
    await live.case(r, `link ${c}`, (t) => {
      t.domainReset(VERSIONS[c % 8]);
      let added: number;
      if (mode <= 1) {
        t.domainAdd(builtin, true);
        t.domainAdd(shell, true);
        added = t.domainAdd(bytes, false);
      } else if (mode <= 3) {
        t.domainAdd(builtin, true);
        t.domainAdd(shell, true);
        const f = t.domainAdd(float, true);
        added = t.domainAdd(bytes, false);
        if (f !== 0) {
          added += 5000000;
        }
      } else if (mode === 4) {
        added = t.domainAdd(bytes, false);
      } else if (mode === 5) {
        added = t.domainAdd(bytes, true);
      } else if (mode === 6) {
        const first = t.domainAdd(mutatedBuiltin, true);
        added = first * 100000 + t.domainAdd(original, false);
        if (first !== 0 || added !== 0) {
          return `add ${added}\n${t.domainSummary()}`;
        }
      } else {
        t.domainAdd(builtin, true);
        t.domainAdd(float, true);
        added = t.domainAdd(bytes, true);
      }

      let text = `add ${added}`;
      if (added === 0) {
        return `${text}\n${t.domainSummary()}\n${t.domainVerifyAll()}\n${t.domainModule(keys)}\n${t.domainIrAll()}`;
      }

      // After a refused link: the domain as it was, then the seed itself linked into it.
      text += `\n${t.domainSummary()}`;
      const again = t.domainAdd(original, false);
      text += `\nthen ${again}\n${t.domainSummary()}`;
      if (again === 0) {
        text += `\n${t.domainVerifyAll()}\n${t.domainModule(keys)}`;
      } else {
        const third = t.domainAdd(original, false);
        text += `\nthird ${third}\n${t.domainSummary()}`;
      }

      return text;
    });
  }
}
