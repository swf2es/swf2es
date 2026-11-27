// Saving and loading a domain, from a review of the idiomatic pass. The
// writer: random sequences of calls, children, ABCs, findings with every
// kind of text, modules, evictions, drops, revivals and compactions, and
// the save each leaves. The reader: those saves with every word of a few
// set to each edge value, cut short at every length, and edited at random,
// each loaded, its ABCs given, rebuilt and saved again.
import { script } from "../../unit/codegen/ir-cases.ts";
import { linkAbcs } from "../../unit/codegen/link-abc.ts";
import type { Compiler, Results } from "../suite.ts";
import { count, type FuzzOptions, generator, type Live } from "./common.ts";

interface Save {
  words: Uint8Array;
  abcs: (Uint8Array | null)[];
}

const TEXTS = [
  "",
  "A",
  "B",
  "flash.display",
  "x".repeat(40),
  "été",
  "中文",
  "😀 astral",
  "a\u0000b",
  "p.q::r",
  "￿\u0001",
];
const VALUES = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 0xfe, 0xff, 0x100, 0x101, 0x1ff, 0xffff, 0x10000, 0x10001, 0x7fffffff,
  0x80000000, 0xfffffffe, 0xffffffff,
];

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kindOf = (n: number) => [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 255][n % 11];

function saveOf(t: Compiler): Save {
  const at = t.domainSaveBytes();
  const words = new Uint8Array(t.memory.buffer, at, t.outputLength()).slice();
  const abcs: (Uint8Array | null)[] = [];
  for (let i = 0; i < 24; i++) {
    const a = t.domainSavedAbcBytes(i);
    abcs.push(a ? new Uint8Array(t.memory.buffer, a, t.outputLength()).slice() : null);
  }

  return { words, abcs };
}

/** What `f` gives, or OOM where memory ran out. */
function orOom(f: () => unknown): string {
  try {
    return String(f());
  } catch (error) {
    if (/ran out of memory/.test((error as Error).message)) {
      return "OOM";
    }

    throw error;
  }
}

/** A save loaded: the answer, its ABCs given, rebuilt, the domain then, saved again. */
function loaded(t: Compiler, save: Save): string {
  t.domainReset(50);
  const load = orOom(() => t.domainLoad(save.words));
  let text = `load ${load}`;
  if (load !== "true") {
    return text;
  }

  for (let i = 0; i < save.abcs.length; i++) {
    const abc = save.abcs[i];
    if (abc) {
      text += ` abc${i}=${orOom(() => t.domainLoadAbc(i, abc))}`;
    }
  }

  const rebuild = orOom(() => t.domainLoadRebuild());
  text += ` rebuild ${rebuild}`;
  if (rebuild !== "true") {
    return text;
  }

  let step = 0;
  for (let guard = 0; step === 0 && guard < 100000; guard++) {
    step = t.domainRebuildStep();
  }

  text += ` step ${step}`;
  if (step !== 1) {
    return text;
  }

  const states = [0, 1, 2, 3, 4, 5, 6, 7].map((d) => orOom(() => t.domainState(d))).join(",");
  text += `\n${orOom(() => t.domainSummary())}\nstates ${states}\nusage ${orOom(() => t.domainUsage()).replace(/\d{5,}/g, "N")}`;
  return `${text}\nresave ${hex(saveOf(t).words)}`;
}

export async function saved(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const { random, below } = generator(o.seed);
  const { builtin, user, created } = linkAbcs();
  // The writer: the same calls on each build, the saves compared byte for byte.
  const genuine: Save[] = [];
  const sequences = count(o, 300, 300);
  for (let q = 0; q < sequences; q++) {
    const plan: ((t: Compiler) => unknown)[] = [
      (t) => t.domainReset([50, 50, 12, 0][q % 4]),
      (t) => t.domainAdd(builtin, true, 0),
    ];
    // Domains to act on: children of the root and of each other, with ABCs, modules and findings.
    const kids = 1 + below(4);
    for (let c = 0; c < kids; c++) {
      const parent = below(c + 1);
      const which = below(3);
      const n0 = below(50);
      const text = TEXTS[below(TEXTS.length)];
      const text2 = TEXTS[below(TEXTS.length)];
      const kind = kindOf(below(11));
      const asType = random() < 0.5;
      plan.push((t) => {
        const d = t.domainChild(parent);
        t.domainAdd(
          which === 0 ? user : which === 1 ? created : script([0x24, n0, 0x48]),
          false,
          d,
        );
        t.domainFound(d, kind, text, text2, 0, asType);
        t.domainFound(d, 0, "", "A", 0, true);
        return t.domainModule("", 1 + c, false, false);
      });
    }

    const steps = 3 + below(22);
    for (let k = 0; k < steps; k++) {
      const d = below(7);
      const d2 = below(7);
      const n = below(60);
      const text = TEXTS[below(TEXTS.length)];
      const text2 = TEXTS[below(TEXTS.length)];
      const flag = random() < 0.5;
      const pick = below(12);
      const abcIndex = below(8);
      plan.push((t) => {
        switch (pick) {
          case 0:
            return t.domainChild(d);
          case 1:
            return t.domainAdd(user, false, d);
          case 2:
            return t.domainAdd(created, false, d);
          case 3:
            return t.domainAdd(script([0x24, n, 0x48]), false, d);
          case 4:
            return t.domainFound(d, kindOf(pick + n), text, text2, abcIndex, flag);
          case 5:
            return t.domainModule("", abcIndex, false, false);
          case 6:
            return t.domainEvict(d);
          case 7:
            return t.domainDrop(1 + d);
          case 8:
            return t.domainRevive(d, false);
          case 9:
            return t.domainCompact(false);
          case 10:
            return t.domainFound(d, 0, "", ["A", "B"][n % 2], abcIndex, flag);
          default:
            return t.domainAdd(script([0x24, n, 0x29, 0x24, d2, 0x48]), false, d2);
        }
      });
    }

    await live.case(r, `writer ${q}`, (t) => {
      let text = "";
      for (const step of plan) {
        text += `${orOom(() => step(t))},`;
      }

      const save = saveOf(t);
      if (save.words.length < 6000 && genuine.length < 60 && q % 3 === 0) {
        genuine.push(save);
      }

      return `${text}\nSAVE ${hex(save.words)}\nABCS ${save.abcs.map((a) => (a ? `${a.length}:${hex(a.subarray(0, 16))}` : "-")).join(" ")}`;
    });
  }

  r.case("saves kept", () => genuine.map((g) => g.words.length).join(","));
  if (genuine.length === 0) {
    return;
  }

  // The reader, systematic: every word of a few saves set to each value, every cut of them, and bytes past them.
  const bySize = genuine.slice().sort((a, b) => a.words.length - b.words.length);
  const inRange = bySize.filter((g) => g.words.length >= 300 && g.words.length <= 2200);
  const fractions = o.deep ? [0, 0.33, 0.66, 1] : [0, 1];
  const small = [
    bySize[0],
    ...fractions.map((f) => inRange[Math.min(inRange.length - 1, Math.floor(f * inRange.length))]),
  ].filter(Boolean);
  for (const [g, save] of small.entries()) {
    const n = save.words.length / 4;
    for (let w = 0; w < n; w++) {
      for (const v of VALUES) {
        const words = new Uint32Array(save.words.slice().buffer);
        if (words[w] === v >>> 0) {
          continue;
        }

        words[w] = v;
        const edited = { words: new Uint8Array(words.buffer), abcs: save.abcs };
        await live.case(r, `save ${g} word ${w} = ${v}`, (t) => loaded(t, edited));
      }
    }

    for (let len = 0; len < save.words.length; len++) {
      const cut = { words: save.words.subarray(0, len), abcs: save.abcs };
      await live.case(r, `save ${g} cut to ${len}`, (t) => loaded(t, cut));
    }

    for (const extra of [1, 3, 4, 8, 64]) {
      const padded = new Uint8Array(save.words.length + extra);
      padded.set(save.words);
      padded.fill(0xff, save.words.length);
      const plus = { words: padded, abcs: save.abcs };
      await live.case(r, `save ${g} plus ${extra}`, (t) => loaded(t, plus));
    }
  }

  // The reader, at random: edits over all the genuine saves, with other saves' ABCs now and then.
  const mutations = count(o, 20000, 20000);
  for (let c = 0; c < mutations; c++) {
    const save = genuine[below(genuine.length)];
    const words = new Uint32Array(save.words.slice().buffer);
    const edits = 1 + below(4);
    for (let e = 0; e < edits; e++) {
      const w = below(words.length);
      switch (below(6)) {
        case 0:
          words[w] = VALUES[below(VALUES.length)];
          break;
        case 1:
          words[w] = words[w] + 1;
          break;
        case 2:
          words[w] = words[w] - 1;
          break;
        case 3:
          words[w] = words[below(words.length)];
          break;
        case 4:
          words[w] ^= 1 << below(32);
          break;
        default: {
          const w2 = below(words.length);
          const x = words[w];
          words[w] = words[w2];
          words[w2] = x;
        }
      }
    }

    let bytes = new Uint8Array(words.buffer);
    if (random() < 0.08) {
      bytes = bytes.subarray(0, below(bytes.length + 1));
    }

    if (random() < 0.03) {
      const padded = new Uint8Array(bytes.length + 16);
      padded.set(bytes);
      bytes = padded;
    }

    const abcs = random() < 0.05 ? genuine[below(genuine.length)].abcs : save.abcs;
    const edited = { words: bytes, abcs };
    await live.case(r, `random ${c}`, (t) => loaded(t, edited));
  }
}
