// Malformed saved domains given to the compiler's domainLoad, the ABCs and
// a rebuild after, then random calls on the domain rebuilt: a bad save
// fails the move cleanly, refused or a rebuild that fails, and nothing
// after a save that loads panics.
//
//   node tests/fuzz/saved.ts [cases, 2000] [seed, 1]
import { fileURLToPath } from "node:url";

const TREE = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const { bindTesting, testingModule } = await import(`${TREE}/tests/unit/codegen/testing-module.ts`);
const { linkAbcs } = await import(`${TREE}/tests/unit/codegen/link-abc.ts`);
const { script } = await import(`${TREE}/tests/unit/codegen/ir-cases.ts`);
const module = await testingModule("testing");
const cases = Number(process.argv[2] ?? 2000);

let seed = Number(process.argv[3] ?? 1);
const r = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// A domain with findings, evicted and dropped domains, and a log of every kind.
const source = await bindTesting(module);
const { builtin, user, created } = linkAbcs();
source.domainReset(50);
source.domainAdd(builtin, true, 0);
const child = source.domainChild(0);
source.domainAdd(user, false, child);
source.domainAdd(created, false, child);
source.domainFound(child, 0, "", "A", 0, true);
source.domainFound(child, 0, "", "B", 0, false);
source.domainModule("", 1, false, false);
source.domainModule("", 2, false, false);
const other = source.domainChild(0);
source.domainAdd(script([0x24, 7, 0x48]), false, other);
source.domainModule("", 3, false, false);
source.domainEvict(other);
const dropped = source.domainChild(child);
source.domainAdd(script([0x24, 9, 0x48]), false, dropped);
source.domainDrop(dropped);
const at = source.domainSaveBytes();
const saved = new Uint8Array(source.memory.buffer, at, source.outputLength()).slice();
const abcs: (Uint8Array | null)[] = [];
for (let i = 0; i < 5; i++) {
  const address = source.domainSavedAbcBytes(i);
  abcs.push(
    address ? new Uint8Array(source.memory.buffer, address, source.outputLength()).slice() : null,
  );
}

console.log(
  `saved ${saved.length} bytes, ${saved.length / 4} words, live ABCs ${abcs.map((a) => a?.length ?? "-")}`,
);

let panics = 0;
let loaded = 0;
let rebuilt = 0;
const kinds = new Map<string, number>();
const fresh = async () => bindTesting(module);
let t = await fresh();
for (let n = 0; n < cases; n++) {
  const words = new Uint32Array(saved.slice().buffer);
  const edits = 1 + Math.floor(r() * 3);
  const what: string[] = [];
  for (let k = 0; k < edits; k++) {
    const w = Math.floor(r() * words.length);
    const value = [
      0,
      1,
      2,
      3,
      4,
      5,
      7,
      100,
      0xffff,
      0x7fffffff,
      0xffffffff,
      words[w] + 1,
      words[w] - 1,
    ][Math.floor(r() * 13)];
    what.push(`word ${w}: ${words[w]} -> ${value >>> 0}`);
    words[w] = value;
  }

  // The domains' states: words 4 + 4d + 2 after their count, word 3. Every
  // live one evicted, or dropped, the root too, now and then.
  if (r() < 0.1) {
    const state = r() < 0.7 ? 1 : 2;
    what.push(`every live domain ${state === 1 ? "evicted" : "dropped"}`);
    for (let d = 0; d < words[3] && 6 + 4 * d < words.length; d++) {
      if (words[6 + 4 * d] === 0) {
        words[6 + 4 * d] = d === 0 || r() < 0.5 ? state : 1;
      }
    }
  }

  const bytes =
    r() < 0.05
      ? new Uint8Array(words.buffer).subarray(0, Math.floor(r() * saved.length))
      : new Uint8Array(words.buffer);
  let phase = "load";
  try {
    t.domainReset(50);
    if (t.domainLoad(bytes)) {
      loaded++;
      for (let i = 0; i < abcs.length; i++) {
        const abc = abcs[i];
        if (abc) {
          t.domainLoadAbc(i, abc);
        }
      }

      phase = "loadAbc";
      if (t.domainLoadRebuild()) {
        phase = "rebuild";
        let step = t.domainRebuildStep();
        while (step === 0) {
          step = t.domainRebuildStep();
        }

        if (step === 1) {
          rebuilt++;
          phase = "after";
          for (let i = 0; i < 5; i++) {
            t.domainContext(i, 0, -1);
            t.domainKeyHeaderBytes(i);
          }

          for (let d = 0; d < 5; d++) {
            t.domainKeyFork(d);
            t.domainKeyLogBytes(d, 0, 0, -1, 4, 0);
          }

          t.domainModule("", 1, false, false);
          phase = "calls";
          const calls = [
            () => t.domainRevive(Math.floor(r() * 6), false),
            () => t.domainEvict(Math.floor(r() * 6)),
            () => t.domainDrop(1 + Math.floor(r() * 5)),
            () => t.domainChild(Math.floor(r() * 6)),
            () => t.domainAdd(script([0x24, 3, 0x48]), false, Math.floor(r() * 6)),
            () => t.domainFound(Math.floor(r() * 6), 0, "", "A", Math.floor(r() * 6), r() < 0.5),
            () => t.domainUsage(),
            () => t.domainWantsCompact(Math.floor(r() * 4)),
            () => t.domainRebuild(false),
            () => t.domainSaveBytes(),
            () => {
              for (let i = 0; i < abcs.length; i++) {
                const abc = abcs[i];
                if (abc) {
                  t.domainRestore(i, abc);
                }
              }
            },
            () => t.domainModule("", Math.floor(r() * 6), false, false),
            () => t.domainState(Math.floor(r() * 6)),
            () => t.domainContext(Math.floor(r() * 6), 0, -1),
          ];
          for (let k = 0; k < 12; k++) {
            const j = Math.floor(r() * calls.length);
            phase = `call ${j}`;
            calls[j]();
          }
        }
      }
    }
  } catch (error) {
    const message = (error as Error).message;
    if (!/ran out of memory/.test(message)) {
      panics++;
      const key = `${phase}: ${message.replace(/[0-9]+/g, "N").slice(0, 110)}`;
      kinds.set(key, (kinds.get(key) ?? 0) + 1);
      if (panics <= 3) {
        console.log(`case ${n}: ${message.slice(0, 160)}\n   ${what.join("; ")}`);
      }

      t = await fresh();
    }
  }
}

console.log(`${cases} cases: ${loaded} loaded, ${rebuilt} rebuilt, ${panics} panics`);
for (const [k, c] of kinds) {
  console.log(`  ${c}x ${k}`);
}

if (panics > 0) {
  process.exitCode = 1;
}
