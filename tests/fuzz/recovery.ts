// Differential fuzz of createCodegen's recovery from a panic of the
// compiler: A, the test build, with panics and stack overflows injected
// (by its marked ABCs, in a compile, in reading a compile's log, and where
// recovery itself fails); B, the same calls with none. Every answer of A's
// is B's, a panicking load rejected as 1107, a panicking compile thrown,
// and the domain alike after; a domain recovery cannot save is lost, and
// both start again.
//
//   node tests/fuzz/recovery.ts [seeds, 20] [first seed, 1] [steps, 300]
//   (COMPACT=1 compacts too, both at the same steps, in spare instances,
//   INPLACE=1 in place half the time, TRANSIENT=1 with domains made,
//   filled and let go of; MOVE=1 has A alone move its domain a few parts
//   at a time between steps (compactStep), B never compacting, with
//   panics injected into A's spare mid-move, which give the move up;
//   PANIC_RATE, VERBOSE=1, STOP=1, DUMP=dir)
import assert from "node:assert/strict";
import * as dumpFs from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TREE = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const { createCodegen } = await import(`${TREE}/packages/codegen/dist/index.js`);
const { classes, mn, METHOD, GETTER, SLOT, OVERRIDE } = await import(
  `${TREE}/tests/unit/codegen/link-cases.ts`
);
const { script } = await import(`${TREE}/tests/unit/codegen/ir-cases.ts`);
const { linkAbcs } = await import(`${TREE}/tests/unit/codegen/link-abc.ts`);
const { TESTED, testingModule } = await import(`${TREE}/tests/unit/codegen/testing-module.ts`);

const seeds = Number(process.argv[2] ?? 20);
const first = Number(process.argv[3] ?? 1);
const steps = Number(process.argv[4] ?? 300);
const COMPACT = process.env.COMPACT === "1";
const MOVE = process.env.MOVE === "1";
const PANIC_RATE = Number(process.env.PANIC_RATE ?? 0.06);
const VERBOSE = process.env.VERBOSE === "1";

// The 0xAA build under SWF2ES_CHECKED.
const module = await testingModule(TESTED);
const builtin = new Uint8Array(readFileSync(`${TREE}/oracle/avmplus/generated/builtin.abc`));

// Every instance's exports, the ones a recovery makes too, with panics
// injected where `inject` names an export, once; and under COMPACT a
// rebuild wanted only where `compacting` says: in a spare instance, or
// with INPLACE in place too. A and B, whose memory differs after A's
// recoveries, must rebuild at the same steps, and one in place must fit
// in memory already taken: where only one did, the other then moves.
const INPLACE = process.env.INPLACE === "1";
let inject: string | null = null;
// Under MOVE, an export of A's spare to panic in once, set only while A's
// compactStep runs, when only the spare calls these.
let spareInject: string | null = null;
const SPARE_CALLS = [
  "domainLoad",
  "domainLoadAbc",
  "domainLoadRebuild",
  "domainRebuildStep",
  "domainAdd",
  "domainRevive",
  "domainRestore",
  "replayEntry",
];
let compacting: "no" | "move" | "in place" = "no";
let refusals = 0;
const wrapped = (instance: WebAssembly.Instance) => {
  const raw = instance.exports as Record<string, (...args: number[]) => number>;
  const exports: Record<string, unknown> = { ...instance.exports };
  for (const name of ["domainModuleBytes", "journalBytes", ...SPARE_CALLS]) {
    exports[name] = (...args: number[]) => {
      if (inject === name) {
        inject = null;
        raw.testingPanic();
      }

      if (spareInject === name) {
        spareInject = null;
        raw.testingPanic();
      }

      return raw[name](...args);
    };
  }

  if (COMPACT || MOVE) {
    // WANT_Spare always; WANT_Move or WANT_InPlace and WANT_InPlaceBesideSpare as compacting says.
    exports.domainWantsCompact = (want: number) =>
      want === 3 || (want === 2 && compacting === "move") || (want < 2 && compacting === "in place")
        ? 1
        : 0;
  }

  return { exports } as unknown as WebAssembly.Instance;
};
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = (async (module: WebAssembly.Module, imports: object) =>
  wrapped((await instantiate(module, imports)) as WebAssembly.Instance)) as typeof instantiate;
const Instance = WebAssembly.Instance;
// A recovery's instance, made synchronously; refused `refusals` times, for the lost path.
WebAssembly.Instance = new Proxy(Instance, {
  construct(target, args) {
    if (refusals > 0) {
      refusals--;
      throw new Error("refused for the fuzz");
    }

    return wrapped(Reflect.construct(target, args));
  },
});
const PANIC = new TextEncoder().encode("\0panic");
const OVERFLOW = new TextEncoder().encode("\0overflow");

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["A", "B", "F", "I", "Error"];
function randomAbc(r: () => number): Uint8Array {
  const pick = <T>(list: T[]) => list[Math.floor(r() * list.length)];
  const kind = r();
  if (kind < 0.15) {
    return script([0x24, Math.floor(r() * 100), 0x48]);
  }

  if (kind < 0.2) {
    return linkAbcs().failing;
  }

  if (kind < 0.25) {
    const bad = new Uint8Array(64 + Math.floor(r() * 64));
    bad[0] = 16;
    bad[2] = 46;
    for (let i = 4; i < bad.length; i++) {
      bad[i] = Math.floor(r() * 256);
    }

    return bad;
  }

  const count = 1 + Math.floor(r() * 2);
  const names = [...NAMES].sort(() => r() - 0.5).slice(0, count);
  const list = names.map((name, i) => {
    const outside = ["Object", "Object", "A", "B"].filter((n) => !names.includes(n));
    const base = i > 0 && r() < 0.5 ? names[i - 1] : pick(outside);
    const traits = [];
    if (r() < 0.6) {
      traits.push({ name: mn("x"), kind: SLOT, index: mn(pick(["A", "B", "Object", "F"])) });
    }

    if (r() < 0.6) {
      traits.push({ name: mn("m"), kind: METHOD, attr: r() < 0.3 ? OVERRIDE : 0 });
    }

    if (r() < 0.3) {
      traits.push({ name: mn("n"), kind: GETTER });
    }

    return { name: mn(name), base: base === name ? mn("Object") : mn(base), traits };
  });
  return classes(list, r() < 0.7);
}

type Codegen = Awaited<ReturnType<typeof createCodegen>>;

/** A call's value, or how it threw: a panic recovered from, a domain lost, or a plain throw. */
const outcome = <T>(call: () => T): { value?: T; error?: string } => {
  try {
    return { value: call() };
  } catch (error) {
    const message = (error as Error).message;
    return {
      error: /its domain lost/.test(message)
        ? "lost"
        : /went on in a new instance/.test(message)
          ? "panic"
          : "threw",
    };
  }
};

interface Counts {
  panics: number;
  recovered: number;
  /** Where recovery was made to fail. */
  lost: number;
  /** Where recovery could not replay, as after a compile cut short. */
  unreplayable: number;
  compactions: number;
  /** Under MOVE: A's moves completed, given up, and the panics injected into its spare. */
  moved: number;
  movesAborted: number;
  spareFaults: number;
  /** Moves given up, by why. */
  why: Record<string, number>;
}

async function run(seed: number): Promise<Counts> {
  const r = rng(seed);
  const pick = <T>(list: T[]) => list[Math.floor(r() * list.length)];
  const a: Codegen = await createCodegen(module);
  const b: Codegen = await createCodegen(module);
  const all = [a, b];
  const trace: string[] = [];
  const ops: unknown[] = [];
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const say = (line: string) => {
    trace.push(line);
    if (VERBOSE) {
      console.log(line);
    }
  };
  const both = <T>(what: string, call: (g: Codegen) => T, compare = true): T | undefined => {
    const fs = dumpFs;
    const results = all.map((g) => outcome(() => call(g)));
    say(`${what} -> ${JSON.stringify(results[1])?.slice(0, 120)}`);
    // B has no panic injected, so none to recover from.
    assert.ok(
      results[1].error !== "panic" && results[1].error !== "lost",
      `seed ${seed}: ${what}: B reports ${results[1].error}`,
    );
    if (compare) {
      try {
        assert.deepEqual(results[0], results[1]);
      } catch (error) {
        if (process.env.DUMP) {
          fs.writeFileSync(
            `${process.env.DUMP}/ops-${seed}.json`,
            JSON.stringify({ ops, n: abcs.length }),
          );
        }
        throw new Error(
          `seed ${seed}: ${what}: recovered differs\n${(error as Error).message.slice(0, 3000)}`,
        );
      }
    }

    return results[1].value;
  };

  // The model.
  let domains: { parent: number; state: number }[] = [];
  let abcs: { domain: number; bytes: Uint8Array }[] = [];
  const logs = new Map<number, string>();
  const hashes = () => abcs.map((_, i) => `h${i}`);
  const liveDomains = () => domains.map((d, i) => (d.state === 0 ? i : -1)).filter((i) => i >= 0);
  const counts: Counts = {
    panics: 0,
    recovered: 0,
    lost: 0,
    unreplayable: 0,
    compactions: 0,
    moved: 0,
    movesAborted: 0,
    spareFaults: 0,
    why: {},
  };
  const start = () => {
    domains = [{ parent: -1, state: 0 }];
    abcs = [];
    logs.clear();
    both("reset", (g) => g.reset());
    both("add builtin", (g) => g.add(builtin, true));
    abcs.push({ domain: 0, bytes: builtin });
  };

  const check = (what: string) => {
    for (let i = 0; i < abcs.length; i++) {
      both(`${what}: context ${i}`, (g) => g.context(i));
      both(`${what}: keyContext ${i}`, (g) => g.keyContext(i, 0), !COMPACT && !MOVE);
    }

    for (let d = 0; d < domains.length; d++) {
      both(`${what}: isLive ${d}`, (g) => g.isLive(d));
    }
  };

  start();
  // Under MOVE, a move given up only where a fault was injected: a panic of
  // the spare, or of the old instance (or a reset after one), or a
  // revival that rebuilt the old instance in place; never refused, and
  // never for a call not journaled but with ANY_FOUND.
  let seenAborts = { ...a.usage().moves.aborted };
  let opsBefore = ops.length;
  const audit = (what: string, spareFaulted: boolean) => {
    const now = a.usage().moves.aborted;
    for (const why of ["spare", "refused", "unjournaled", "superseded"] as const) {
      if (now[why] > seenAborts[why]) {
        const faulted =
          why === "superseded"
            ? /^(panic|revive)/.test(what)
            : why === "spare"
              ? spareFaulted
              : why === "unjournaled" && process.env.ANY_FOUND === "1";
        assert.ok(faulted, `seed ${seed}: a move given up (${why}) at ${what}, with no fault`);
      }
    }

    seenAborts = { ...now };
  };
  for (let step = 0; step < steps; step++) {
    if (MOVE) {
      const last = ops.length > opsBefore ? (ops.at(-1) as { op: string }).op : "nothing";
      audit(last, false);
      opsBefore = ops.length;
    }

    // A few parts of A's move between B's and A's calls, a spare's panic
    // now and then among them.
    if (MOVE && r() < 0.35) {
      const parts = 1 + Math.floor(r() * 6);
      const injected = r() < 0.08 ? pick(SPARE_CALLS) : null;
      spareInject = injected;
      compacting = "move";
      const before = a.usage().moves;
      const progress: string[] = [];
      for (let k = 0; k < parts; k++) {
        const result = outcome(() => a.compactStep({ timeRemaining: () => 0 }));
        assert.ok(
          result.error === undefined,
          `seed ${seed}: compactStep at step ${step} threw ${result.error}`,
        );
        progress.push(result.value as string);
        if (result.value !== "moving") {
          break;
        }
      }

      compacting = "no";
      audit("move", injected !== null && spareInject === null);
      if (injected !== null && spareInject === null) {
        counts.spareFaults++;
        assert.equal(
          a.usage().moves.aborted.spare,
          before.aborted.spare + 1,
          `seed ${seed}: a panic of the spare in ${injected} at step ${step} gave the move up`,
        );
      }

      spareInject = null;
      say(`move ${progress.join(" ")}`);
      // Each swap compiles and resolves as B, which never compacts.
      if (progress.includes("done")) {
        check(`after a move (step ${step})`);
        for (let i = 1; i < abcs.length; i++) {
          both(`after a move (step ${step}): compile ${i}`, (g) => g.compileModule(hashes(), i));
        }
      }

      // A spare, which compactStep asks for, made between steps.
      await new Promise((resolve) => setImmediate(resolve));
    }

    const x = r();
    // A panic in a compile, or in reading its log, which recovery undoes.
    if (x < PANIC_RATE / 3 && abcs.length > 1) {
      const i = 1 + Math.floor(r() * (abcs.length - 1));
      inject = r() < 0.5 ? "domainModuleBytes" : "journalBytes";
      ops.push({ op: "panic-compile", i, at: inject });
      const result = outcome(() => a.compileModuleLogged(hashes(), i));
      say(`PANIC in compile ${i} (${inject}) -> ${JSON.stringify(result)}`);
      const injected = inject === null;
      inject = null;
      if (!injected) {
        continue;
      }

      counts.panics++;
      // Not replayable since an earlier compile was cut short: lost by design.
      if (result.error === "lost") {
        counts.unreplayable++;
        start();
        continue;
      }

      assert.deepEqual(
        result,
        { error: "panic" },
        `seed ${seed}: the panicking compile at step ${step}`,
      );
      counts.recovered++;
      check(`after compile panic ${counts.panics} (step ${step})`);
      continue;
    }

    // A panic recovery cannot undo: the domain is lost, and both start again.
    if (x < PANIC_RATE / 2) {
      refusals = 1;
      ops.push({ op: "panic-lost" });
      const result = outcome(() => a.add(PANIC, false, 0));
      refusals = 0;
      say(`PANIC, lost -> ${JSON.stringify(result)}`);
      counts.panics++;
      // A spare instance, made for a compaction, needs no new one: recovered.
      if (result.value === 1107) {
        counts.recovered++;
        check(`after panic ${counts.panics} (step ${step})`);
        continue;
      }

      assert.deepEqual(result, { error: "lost" }, `seed ${seed}: the lost panic at step ${step}`);
      assert.deepEqual(
        outcome(() => a.compileModule(hashes(), 0)),
        { error: "threw" },
      );
      counts.lost++;
      start();
      continue;
    }

    if (x < PANIC_RATE) {
      const marker = r() < 0.8 ? PANIC : OVERFLOW;
      const where = pick(liveDomains());
      ops.push({ op: "panic", marker: b64(marker), where });
      const result = outcome(() => a.add(marker, false, where));
      say(`PANIC in ${where} -> ${JSON.stringify(result)}`);
      if (result.value !== 1107) {
        try {
          a.add(marker, false, where);
        } catch (error) {
          console.log(`the panicking add threw: ${(error as Error).message}`);
        }

        if (process.env.DUMP) {
          dumpFs.writeFileSync(
            `${process.env.DUMP}/ops-${seed}.json`,
            JSON.stringify({ ops, n: abcs.length }),
          );
        }
      }
      assert.deepEqual(result, { value: 1107 }, `seed ${seed}: the panicking add at step ${step}`);
      counts.panics++;
      counts.recovered++;
      check(`after panic ${counts.panics} (step ${step})`);
      continue;
    }

    if (x < 0.3) {
      const bytes = randomAbc(r);
      const domain = r() < 0.9 ? pick(liveDomains()) : Math.floor(r() * (domains.length + 1));
      ops.push({ op: "add", bytes: b64(bytes), domain });
      const error = both(`add to ${domain} (${bytes.length} bytes)`, (g) =>
        g.add(bytes, false, domain),
      );
      if (error === 0) {
        abcs.push({ domain, bytes });
      }
    } else if (x < 0.4) {
      const parent = r() < 0.9 ? pick(liveDomains()) : Math.floor(r() * (domains.length + 1));
      ops.push({ op: "child", parent });
      const made = both(`child of ${parent}`, (g) => g.childDomain(parent));
      if (made !== undefined) {
        assert.equal(made, domains.length);
        domains.push({ parent, state: 0 });
      }
    } else if (x < 0.47 && domains.length > 1) {
      const d = 1 + Math.floor(r() * (domains.length - 1));
      ops.push({ op: "drop", d });
      both(`drop ${d}`, (g) => g.dropDomain(d));
      for (let k = d; k < domains.length; k++) {
        let p = k;
        while (p > 0 && p !== d) {
          p = domains[p].parent;
        }

        if (p === d) {
          domains[k].state = 2;
        }
      }
    } else if (x < 0.54 && domains.length > 1) {
      const d = 1 + Math.floor(r() * (domains.length - 1));
      ops.push({ op: "evict", d });
      both(`evict ${d}`, (g) => g.evictDomain(d));
      for (let k = d; k < domains.length; k++) {
        let p = k;
        while (p > 0 && p !== d) {
          p = domains[p].parent;
        }

        if (p === d && domains[k].state === 0) {
          domains[k].state = 1;
        }
      }
    } else if (x < 0.62 && domains.length > 1) {
      const d = 1 + Math.floor(r() * (domains.length - 1));
      const chain = new Set<number>();
      for (let p = d; p > 0 && domains[p].state === 1; p = domains[p].parent) {
        chain.add(p);
      }

      const bytes = () =>
        new Map(
          abcs
            .map((abc, i) => [i, abc] as const)
            .filter(([, abc]) => chain.has(abc.domain))
            .map(([i, abc]) => [i, abc.bytes] as const),
        );
      ops.push({ op: "revive", d, abcs: [...bytes()].map(([i, x]) => [i, b64(x)]) });
      const revived = all.map((g) => {
        try {
          g.reviveDomain(d, bytes());
          return {};
        } catch (error) {
          return { error: "threw", message: (error as Error).message };
        }
      });
      if (JSON.stringify(revived[0].error) !== JSON.stringify(revived[1].error)) {
        console.log(
          `revive ${d}: ${JSON.stringify(revived)} given ${[...bytes().keys()]} usage ${JSON.stringify(all.map((g) => g.usage()))}`,
        );
      }
      for (const result of revived) {
        delete (result as { message?: string }).message;
      }
      say(`revive ${d} -> ${JSON.stringify(revived)}`);
      assert.deepEqual(revived[0], revived[1], `seed ${seed}: revive ${d} at step ${step}`);
      if (!revived[1].error) {
        for (const p of chain) {
          domains[p].state = 0;
        }
      }

      // Authoritative: ask.
      for (let k = 0; k < domains.length; k++) {
        const live = both(`isLive ${k}`, (g) => g.isLive(k));
        if (domains[k].state !== 2) {
          domains[k].state = live ? 0 : 1;
        }
      }
    } else if (x < 0.7) {
      const domain = Math.floor(r() * domains.length);
      const definition = {
        domain,
        nsKind: 0,
        uri: r() < 0.9 ? "" : "A",
        name: pick(["A", "B", "Object", "F", "xé\ud83d", "I"]),
        abc: (() => {
          if (process.env.ANY_FOUND === "1") {
            return Math.floor(r() * (abcs.length + 1));
          }

          const chain = new Set<number>();
          for (let p = domain; p >= 0; p = domains[p].parent) {
            chain.add(p);
          }

          const seen = abcs.map((abc, i) => (chain.has(abc.domain) ? i : -1)).filter((i) => i >= 0);
          return seen.length ? pick(seen) : 0;
        })(),
        asType: r() < 0.5,
      };
      ops.push({ op: "found", definition });
      both(`found ${JSON.stringify(definition)}`, (g) => g.found(definition));
    } else if (x < 0.85) {
      const i = Math.floor(r() * abcs.length);
      if (i === 0 && r() < 0.8) {
        continue;
      }

      ops.push({ op: "compile", i, n: abcs.length });
      if (r() < 0.5) {
        both(`compileModule ${i}`, (g) => g.compileModule(hashes(), i));
      } else {
        const logged = both(`compileModuleLogged ${i}`, (g) => g.compileModuleLogged(hashes(), i));
        if (logged?.log != null) {
          logs.set(i, logged.log);
        }
      }
    } else if (x < 0.9 && logs.size > 0) {
      const i = pick([...logs.keys()]);
      ops.push({ op: "replay", i, log: logs.get(i) });
      both(`replay ${i}`, (g) => g.replay(logs.get(i) as string, i));
    } else if (x < 0.95) {
      const i = Math.floor(r() * abcs.length);
      both(`context ${i}`, (g) => g.context(i));
      both(`keyContext ${i}`, (g) => g.keyContext(i, 0), !COMPACT && !MOVE);
    } else if (COMPACT && process.env.TRANSIENT === "1" && r() < 0.6) {
      ops.push({ op: "child", parent: 0 });
      const made = both("transient child", (g) => g.childDomain(0));
      if (made !== undefined) {
        domains.push({ parent: 0, state: 0 });
        const copies = 1 + Math.floor(r() * 12);
        for (let k = 0; k < copies; k++) {
          ops.push({ op: "addBuiltin", domain: made });
          if (both("transient builtin", (g) => g.add(builtin, true, made)) === 0) {
            abcs.push({ domain: made as number, bytes: builtin });
          }
        }

        if (r() < 0.5) {
          ops.push({ op: "drop", d: made });
          both("transient drop", (g) => g.dropDomain(made as number));
          domains[made as number].state = 2;
        } else {
          ops.push({ op: "evict", d: made });
          both("transient evict", (g) => g.evictDomain(made as number));
          domains[made as number].state = 1;
        }
      }
    } else if (COMPACT) {
      ops.push({ op: "compact" });
      // Each with a spare instance first, made between steps.
      for (const g of all) {
        g.compact();
      }

      await new Promise((resolve) => setTimeout(resolve, 5));
      compacting = INPLACE && r() < 0.5 ? "in place" : "move";
      const how = compacting;
      const done = all.map((g) => outcome(() => g.compact()));
      if (compacting === "in place" && done[0].value !== done[1].value) {
        // Only one fitted in place: the other rebuilds in its spare.
        const behind = done[0].value ? 1 : 0;
        compacting = "move";
        done[behind] = outcome(() => all[behind].compact());
        say(`compact in place by one, moved by the other -> ${JSON.stringify(done)}`);
      }

      compacting = "no";
      say(`compact ${how} -> ${JSON.stringify(done)}`);
      assert.deepEqual(done[0], done[1], `seed ${seed}: compact at step ${step}`);
      if (done[0].value) {
        counts.compactions++;
      }

      // A spare instance, which compact asks for, made between steps.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  check("at the end");
  for (let i = 1; i < abcs.length; i++) {
    both(`final compile ${i}`, (g) => g.compileModule(hashes(), i));
  }

  check("after the final compiles");
  const moves = a.usage().moves;
  counts.moved = moves.completed;
  counts.why = { ...moves.aborted };
  counts.movesAborted = (Object.values(moves.aborted) as number[]).reduce((sum, n) => sum + n, 0);
  return counts;
}

const total: Counts = {
  panics: 0,
  recovered: 0,
  lost: 0,
  unreplayable: 0,
  compactions: 0,
  moved: 0,
  movesAborted: 0,
  spareFaults: 0,
  why: {},
};
let failures = 0;
for (let seed = first; seed < first + seeds; seed++) {
  try {
    const result = await run(seed);
    for (const key of Object.keys(total) as (keyof Counts)[]) {
      if (key === "why") {
        for (const [why, n] of Object.entries(result.why)) {
          total.why[why] = (total.why[why] ?? 0) + n;
        }
      } else {
        total[key] += result[key];
      }
    }
  } catch (error) {
    failures++;
    console.log(`FAIL ${(error as Error).message.slice(0, 4000)}`);
    if (process.env.STACK) {
      console.log((error as Error).stack?.split("\n").slice(0, 12).join("\n"));
    }
    if (process.env.STOP === "1") {
      break;
    }
  }
}

console.log(
  `${seeds} seeds from ${first}, ${steps} steps each: ${total.panics} panics injected, ` +
    `${total.recovered} recovered, ${total.lost} lost as made to, ${total.unreplayable} lost as ` +
    `not replayable, ${total.compactions} compactions, ` +
    (MOVE
      ? `${total.moved} moves, ${total.movesAborted} given up ${JSON.stringify(total.why)} ` +
        `(${total.spareFaults} spare panics), `
      : "") +
    `${failures} failures`,
);
if (total.recovered + total.lost + total.unreplayable !== total.panics) {
  console.log("not every injected panic was recovered from or lost by design");
  process.exitCode = 1;
}

if (failures > 0) {
  process.exitCode = 1;
}
