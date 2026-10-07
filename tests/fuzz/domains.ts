// Fuzzes the compiler's application domains against a reference that never
// lets go of one. Two instances of the test build are given the same ABCs,
// child domains and findings in the same random order; one of them also
// drops, evicts, revives and rebuilds domains at random, and every module,
// entry and method compiled alone of a live ABC must come out of both the
// same, byte for byte: what a rebuild links and resolves again must be what
// the reference linked and resolved the first time (docs/architecture.md,
// Linking).
//
// The ABCs are the conformance cases, compiled into this package's out/,
// and classes made by hand to collide: an A, a B and an F of different
// layouts, B's slot typed A, so that a domain's type resolved before an
// ancestor defines another A of the same name is resolved again after
// it. A failure prints the step and where the two modules part.
//
//   node tests/fuzz/domains.ts [steps, 3000] [seed, 1]
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { containerEngine, libraries, runOracle } from "../../oracle/oracle.ts";
import { classes, GETTER, METHOD, mn, OVERRIDE, SLOT } from "../unit/codegen/link-cases.ts";
import { loadTesting } from "../unit/codegen/testing-module.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const steps = Number(process.argv[2] ?? 3000);
const seed = Number(process.argv[3] ?? 1);

let engine: string;
try {
  engine = containerEngine();
} catch (e) {
  console.log(`domains: skipped (${(e as Error).message})`);
  process.exit(0);
}

const roots = libraries(["builtin", "shell_toplevel"], `${out}lib`, { engine }).map((l) => l.abc);
const cases = `${here}../conformance/cases/`;
const pool: Uint8Array[] = [];
for (const result of runOracle(
  readdirSync(cases)
    .filter((f) => f.endsWith(".as"))
    .map((f) => ({ source: `${cases}${f}`, ascArgs: ["-md"] })),
  out,
  { engine },
)) {
  if (result.compiled) {
    pool.push(new Uint8Array(readFileSync(`${out}${result.name}.abc`)));
  }
}

// The names each made-up ABC defines, which a domain may be told it found.
const defines = new Map<Uint8Array, string[]>();
const made = (names: string[], abc: Uint8Array) => {
  defines.set(abc, names);
  return abc;
};
const colliding = [
  made(
    ["A"],
    classes(
      [
        {
          name: mn("A"),
          base: mn("Object"),
          traits: [
            { name: mn("m"), kind: METHOD },
            { name: mn("x"), kind: GETTER },
          ],
        },
      ],
      true,
    ),
  ),
  made(
    ["A"],
    classes(
      [
        {
          name: mn("A"),
          base: mn("Object"),
          traits: [
            { name: mn("x"), kind: SLOT },
            { name: mn("n"), kind: SLOT },
          ],
        },
      ],
      true,
    ),
  ),
  made(
    ["B"],
    classes(
      [
        {
          name: mn("B"),
          base: mn("A"),
          traits: [
            { name: mn("m"), kind: METHOD, attr: OVERRIDE },
            { name: mn("F"), kind: METHOD },
          ],
        },
      ],
      true,
    ),
  ),
  // Resolved by a lookup alone, and as created.
  made(
    ["B"],
    classes([
      {
        name: mn("B"),
        base: mn("Object"),
        traits: [{ name: mn("x"), kind: SLOT, index: mn("A") }],
      },
    ]),
  ),
  made(
    ["B", "F"],
    classes(
      [
        {
          name: mn("B"),
          base: mn("Object"),
          traits: [{ name: mn("x"), kind: SLOT, index: mn("A") }],
        },
        { name: mn("F"), base: mn("B"), traits: [{ name: mn("n"), kind: SLOT, index: mn("A") }] },
      ],
      true,
    ),
  ),
  made(
    ["F"],
    classes([{ name: mn("F"), base: mn("A"), traits: [{ name: mn("n"), kind: SLOT }] }], true),
  ),
];
for (let k = 0; k < 4; k++) {
  pool.push(...colliding);
}

/** mulberry32: a small generator whose sequence the seed fixes. */
function generator(start: number): () => number {
  let s = start >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = generator(seed);
const below = (n: number) => Math.floor(random() * n);
const pick = <T>(list: T[]) => list[below(list.length)];

const build = process.env.SWF2ES_CHECKED ? "dist-test-checked" : "dist-test";
const subject = await loadTesting(build);
const reference = await loadTesting(build);
for (const t of [subject, reference]) {
  t.domainReset(50);
  for (const r of roots) {
    t.domainAdd(r, true, 0);
  }
}

// What both were given: each ABC's hash, bytes and domain, each domain's parent.
const hashes = roots.map((_, i) => `r${i}`);
const bytes: Uint8Array[] = [...roots];
const abcDomain = roots.map(() => 0);
const parent = [-1];
const failures: string[] = [];
const counts = { compiles: 0, drops: 0, evictions: 0, revivals: 0, rebuilds: 0, findings: 0 };

/** Ask both the same; they must answer alike. */
// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
function both<T>(ask: (t: any) => T): T {
  const answer = ask(subject);
  if (answer !== ask(reference)) {
    throw new Error("the instances answered differently");
  }

  return answer;
}

const state = (d: number) => subject.domainState(d) as number;
const live = () => parent.map((_, d) => d).filter((d) => state(d) === 0);
const where = (text: string, at: number) => text.slice(Math.max(0, at - 150), at + 150);

/** Compare module, entries and methods compiled alone of ABC `i` in both. */
function compare(step: number, i: number): void {
  counts.compiles++;
  const joined = hashes.join("\n");
  const a: string = subject.domainModule(joined, i, true);
  const b: string = reference.domainModule(joined, i, true);
  if (a !== b) {
    const at = [...a].findIndex((c, k) => c !== b[k]);
    failures.push(
      `step ${step}: ABC ${i}'s module differs\n${where(a, at)}\n----\n${where(b, at)}`,
    );
    return;
  }

  // What its classes' slots resolved to, which only code elsewhere that
  // reads them would show.
  for (let c = 0; ; c++) {
    const types: string = subject.domainSlotTypes(i, c);
    if (types !== reference.domainSlotTypes(i, c)) {
      failures.push(`step ${step}: ABC ${i}'s class ${c} has slots of other types`);
      return;
    }

    if (types === "none") {
      break;
    }
  }

  const entries: string = subject.domainModuleEntries();
  if (entries !== reference.domainModuleEntries()) {
    failures.push(`step ${step}: ABC ${i}'s entries differ`);
    return;
  }

  const bodies = entries
    .split("\u0002")
    .map((e) => e.split("\u0001")[0])
    .filter((e) => e)
    .join(",");
  if (
    bodies &&
    subject.domainEmitEach(bodies, below(2) === 0, i) !== reference.domainEmitEach(bodies, false, i)
  ) {
    failures.push(`step ${step}: ABC ${i}'s methods compiled alone differ`);
  }
}

/** Revive evicted domain `d` in the subject with its evicted ancestors, given their ABCs if asked. */
function revive(step: number, d: number): void {
  let revived = subject.domainRevive(d);
  if (revived < 0) {
    for (let i = 0; i < hashes.length; i++) {
      if (state(abcDomain[i]) === 1 && subject.domainRestore(i, bytes[i]) !== 0) {
        failures.push(`step ${step}: ABC ${i} was not restored`);
      }
    }

    revived = subject.domainRevive(d);
  }

  if (revived < 0) {
    failures.push(`step ${step}: domain ${d} was not revived`);
  }

  counts.revivals++;
}

/**
 * The pattern a rebuild once got wrong: a domain below the root has an A
 * and a B whose slot is typed A, and B resolves; then an ancestor gets an
 * A of its own, which a lookup from the domain now finds first. B's slot
 * must keep the A it resolved to, in a rebuild too.
 */
function shadow(step: number): void {
  const below0 = live().filter((d) => d > 0);
  if (!below0.length) {
    return;
  }

  const d = pick(below0);
  const add = (abc: Uint8Array, to: number) => {
    if (both((t) => t.domainAdd(abc, false, to)) === 0) {
      hashes.push(`h${hashes.length}`);
      bytes.push(abc);
      abcDomain.push(to);
    }
  };
  add(colliding[0], d);
  add(pick([colliding[3], colliding[4]]), d);
  compare(step, hashes.length - 1);
  add(colliding[1], parent[d]);
}

const started = Date.now();
let step = 0;
for (; step < steps && failures.length === 0; step++) {
  const op = below(100);
  if (op < 12) {
    const p = pick(live());
    both((t) => t.domainChild(p));
    parent.push(p);
  } else if (op < 40) {
    const d = pick(live());
    const abc = pick(pool);
    if (both((t) => t.domainAdd(abc, false, d)) === 0) {
      hashes.push(`h${hashes.length}`);
      bytes.push(abc);
      abcDomain.push(d);
    }
  } else if (op < 60) {
    const compilable = hashes
      .map((_, i) => i)
      .filter((i) => i >= roots.length && state(abcDomain[i]) === 0);
    if (compilable.length) {
      compare(step, pick(compilable));
    }
  } else if (op < 66) {
    const droppable = live().filter((d) => d > 0);
    if (droppable.length) {
      subject.domainDrop(pick(droppable));
      counts.drops++;
    }
  } else if (op < 78) {
    const evictable = live().filter((d) => d > 0);
    if (evictable.length) {
      subject.domainEvict(pick(evictable));
      counts.evictions++;
    }
  } else if (op < 88) {
    const evicted = parent.map((_, d) => d).filter((d) => state(d) === 1);
    if (evicted.length) {
      revive(step, pick(evicted));
    }
  } else if (op < 90) {
    shadow(step);
  } else if (op < 93) {
    if (subject.domainRebuild()) {
      counts.rebuilds++;
    } else {
      failures.push(`step ${step}: a rebuild failed`);
    }
  } else {
    // A live domain finds a name of a made-up ABC its chain has, which may
    // not be the first from the root down.
    const d = pick(live());
    const chain: number[] = [];
    for (let x = d; x >= 0; x = parent[x]) {
      chain.push(x);
    }

    const found = hashes
      .map((_, i) => i)
      .filter((i) => chain.includes(abcDomain[i]) && defines.has(bytes[i]));
    if (found.length) {
      const i = pick(found);
      const name = pick(defines.get(bytes[i]) ?? []);
      const asType = below(2) === 0;
      for (const t of [subject, reference]) {
        t.domainFound(d, 0, "", name, i, asType);
      }

      counts.findings++;
    }
  }

  // Let the subject's garbage go now and then, as a host does between calls.
  if (step % 16 === 0) {
    subject.__collect();
    reference.__collect();
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const summary = `${step} steps (seed ${seed}), ${hashes.length} ABCs in ${parent.length} domains, ${counts.compiles} compiled, ${counts.drops} drops, ${counts.evictions} evictions, ${counts.revivals} revivals, ${counts.rebuilds} rebuilds, ${counts.findings} findings`;
if (failures.length) {
  console.log(failures.join("\n"));
  console.log(`domains: failed after ${summary} (${seconds} s)`);
  process.exit(1);
}

console.log(`domains: ${summary}, all alike (${seconds} s)`);
