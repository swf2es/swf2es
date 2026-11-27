// Codegen.compactStep's move a part at a time (packages/codegen/src/index.ts):
// the host's calls go on meanwhile and are replayed into the spare, which
// then takes the old instance's place; any failure of the spare, and any
// call that leaves it unable to catch up, gives the move up and leaves the
// domain as it was. Every module is the one a compiler that never
// compacted writes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Codegen, createCodegen } from "../../../packages/codegen/dist/index.js";
import {
  builtinLibrary,
  playerglobalLibrary,
} from "../../../packages/player/dist/playerglobal/libraries.js";
import { script } from "./ir-cases.ts";
import { linkAbcs } from "./link-abc.ts";
import { testingModule } from "./testing-module.ts";

const module = await testingModule("testing");
const PANIC = new TextEncoder().encode("\0panic");
const NO_TIME = { timeRemaining: () => 0 };

type Fault = {
  /** The instance, by the order they were made in: 0 the first, 1 the first spare. */
  instance: number;
  name: string;
  kind: "panic" | "oom" | "refuse";
  /** Calls of `name` to let by first. */
  skip: number;
};

/**
 * Instances of the test build with a small part budget, so that a rebuild
 * takes many steps; compaction wanted as `want` says, a move (with a spare
 * made ahead), in place, or neither; and `fault` injected once.
 */
function instrument(t: { mock: { method: typeof import("node:test").mock.method } }) {
  const state = {
    want: "move" as "move" | "in place" | "no",
    fault: null as Fault | null,
    made: 0,
    /** Calls of domainCompact, a rebuild in place begun. */
    inPlace: 0,
  };
  t.mock.method(WebAssembly, "instantiate", async (module: WebAssembly.Module, imports: object) => {
    const instance = new WebAssembly.Instance(module, imports);
    // biome-ignore lint/suspicious/noExplicitAny: the test build's raw exports
    const raw = instance.exports as any;
    raw.domainPartBudget(4096);
    const n = state.made++;
    let oom = false;
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const exports: any = { ...raw };
    exports.domainWantsCompact = (want: number) =>
      want === 3 || (want === 2 && state.want === "move") || (want < 2 && state.want === "in place")
        ? 1
        : 0;
    exports.codegenError = () => {
      if (oom) {
        oom = false;
        return 1;
      }

      return raw.codegenError();
    };
    exports.domainCompact = (...args: number[]) => {
      state.inPlace++;
      return raw.domainCompact(...args);
    };
    for (const name of [
      "domainLoad",
      "domainLoadAbc",
      "domainLoadRebuild",
      "domainRebuildStep",
      "domainAdd",
      "domainRevive",
      "domainRestore",
      "replayEntry",
      "journalBytes",
    ]) {
      exports[name] = (...args: number[]) => {
        const fault = state.fault;
        if (fault && fault.instance === n && fault.name === name && fault.skip-- <= 0) {
          state.fault = null;
          switch (fault.kind) {
            case "panic":
              raw.testingPanic();
              break;
            case "oom":
              oom = true;
              break;
            case "refuse":
              return name === "domainRebuildStep" ? -1 : 0;
          }
        }

        return raw[name](...args);
      };
    }

    return { exports };
  });
  return state;
}

/** A domain with live ABCs, one evicted child, and enough dropped to be worth compacting. */
function setUp(c: Codegen) {
  const abc = linkAbcs();
  c.reset();
  assert.equal(c.add(builtinLibrary, true), 0);
  // Verified, so that a rebuild verifies it again, a part at a time.
  c.compileModule([], 0);
  const kept = c.childDomain(0);
  assert.equal(c.add(abc.builtin, false, kept), 0);
  assert.equal(c.add(abc.user, false, kept), 0);
  c.compileModule([], 1);
  c.compileModule([], 2);
  const evicted = c.childDomain(0);
  assert.equal(c.add(script([0x24, 7, 0x48]), false, evicted), 0);
  c.compileModule([], 3);
  c.evictDomain(evicted);
  for (let i = 0; i < 6; i++) {
    const transient = c.childDomain(0);
    assert.equal(c.add(builtinLibrary, true, transient), 0);
    c.dropDomain(transient);
  }

  return { kept, evicted, added: 10 };
}

type Domain = ReturnType<typeof setUp>;

/**
 * The calls a host makes, the `i`th of them: loads into new children and
 * compiles, findings, evictions, revivals of the child evicted before
 * the move and of later ones, and drops.
 */
function call(c: Codegen, d: Domain & { made: number[] }, i: number): void {
  switch (i % 7) {
    case 0: {
      const child = c.childDomain(i % 14 === 0 ? 0 : d.kept);
      d.made.push(child);
      assert.equal(c.add(script([0x24, i & 0x7f, 0x48]), false, child), 0);
      c.compileModule([], d.added++);
      break;
    }
    case 1:
      c.found({ domain: d.kept, nsKind: 0, uri: "", name: "A", abc: 1, asType: true });
      break;
    case 2:
      if (c.isLive(d.evicted)) {
        c.evictDomain(d.evicted);
      } else {
        c.reviveDomain(d.evicted, new Map([[3, script([0x24, 7, 0x48])]]));
      }
      break;
    case 3: {
      const child = c.childDomain(d.kept);
      assert.equal(c.add(linkAbcs().user, false, child), 0);
      c.compileModule([], d.added++);
      d.made.push(child);
      break;
    }
    case 4:
      if (d.made.length > 1) {
        c.evictDomain(d.made[d.made.length - 2]);
      }
      break;
    case 5:
      if (d.made.length > 2) {
        c.dropDomain(d.made.splice(0, 1)[0]);
      }
      break;
    case 6:
      c.compileModule([], 2);
      break;
  }
}

/** What every ABC compiles to, and its context, or why it does not. */
function outcome(c: Codegen, added: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < added; i++) {
    try {
      out.push(`${c.compileModule([], i)}\n${JSON.stringify(c.context(i))}`);
    } catch (error) {
      out.push(`threw ${(error as Error).message}`);
    }
  }

  return out;
}

/** The same calls on a compiler that never compacts. */
async function twin(calls: number) {
  const c = await createCodegen(module);
  const d = { ...setUp(c), made: [] as number[] };
  for (let i = 0; i < calls; i++) {
    call(c, d, i);
  }

  return outcome(c, d.added);
}

/** A spare made: instantiating is asynchronous. */
const spareMade = () => new Promise((resolve) => setImmediate(resolve));

/** compactStep with no time, a part a call, until a move has started: what that call gave. */
async function startMove(c: Codegen): Promise<string> {
  const started = c.usage().moves.started;
  for (let tries = 0; tries < 10; tries++) {
    const progress = c.compactStep(NO_TIME);
    if (c.usage().moves.started > started) {
      return progress;
    }

    await spareMade();
  }

  assert.fail("no move started");
}

for (const every of [1, 5, 25]) {
  test(`calls made every ${every} parts of a move are replayed into the spare`, async (t) => {
    const state = instrument(t);
    const c = await createCodegen(module);
    const d = { ...setUp(c), made: [] as number[] };
    await startMove(c);
    let calls = 0;
    let parts = 0;
    let progress = "moving";
    while (progress === "moving") {
      progress = c.compactStep(NO_TIME);
      if (++parts % every === 0 && calls < 60) {
        call(c, d, calls++);
      }
    }

    assert.equal(progress, "done");
    const usage = c.usage();
    assert.equal(usage.moves.completed, 1);
    assert.equal(usage.failedMoves, 0);
    assert.ok(calls > 0, "calls were made during the move");
    state.want = "no";
    // The new instance goes on, and recovers from its checkpoint, the
    // snapshot, and the calls since, revivals that rebuild included.
    for (; calls < 70; calls++) {
      call(c, d, calls);
    }

    assert.equal(c.add(PANIC), 1107);
    assert.deepEqual(outcome(c, d.added), await twin(calls));
  });
}

test("many moves in turn, each swap compiling as a compiler that never compacted", async (t) => {
  instrument(t);
  const c = await createCodegen(module);
  const twinned = await createCodegen(module);
  const d = { ...setUp(c), made: [] as number[] };
  const e = { ...setUp(twinned), made: [] as number[] };
  let calls = 0;
  for (let moved = 1; moved <= 6; moved++) {
    let progress = await startMove(c);
    let parts = 0;
    while (progress === "moving") {
      progress = c.compactStep(NO_TIME);
      // Calls every few parts, in every phase, and some between moves.
      if (++parts % (moved + 1) === 0) {
        call(c, d, calls);
        call(twinned, e, calls++);
      }
    }

    assert.equal(progress, "done", `move ${moved}`);
    assert.equal(c.usage().moves.completed, moved);
    assert.deepEqual(outcome(c, d.added), outcome(twinned, e.added), `after move ${moved}`);
    for (let k = 0; k < 3; k++) {
      call(c, d, calls);
      call(twinned, e, calls++);
    }
  }

  // The last move's checkpoint and journal recover the domain.
  assert.equal(c.add(PANIC), 1107);
  assert.equal(twinned.add(PANIC), 1107);
  assert.deepEqual(outcome(c, d.added), outcome(twinned, e.added));
});

test("a move whose catch-up keeps being outrun finishes catching up in one slice", async (t) => {
  instrument(t);
  const c = await createCodegen(module);
  const d = { ...setUp(c), made: [] as number[] };
  await startMove(c);
  let calls = 0;
  let progress = "moving";
  while (progress === "moving") {
    progress = c.compactStep(NO_TIME);
    // Two calls a part: catching up one entry a part never ends.
    for (let k = 0; k < 2 && calls < 400; k++) {
      call(c, d, calls++);
    }
  }

  assert.equal(progress, "done");
  assert.ok(calls < 400, `caught up after ${calls} calls`);
  assert.deepEqual(outcome(c, d.added), await twin(calls));
});

for (const [name, kind, skip] of [
  ["domainLoad", "refuse", 0],
  ["domainLoad", "panic", 0],
  ["domainLoadAbc", "panic", 1],
  ["domainLoadAbc", "oom", 1],
  ["domainRebuildStep", "panic", 20],
  ["domainRebuildStep", "oom", 20],
  ["domainRebuildStep", "refuse", 20],
  ["domainAdd", "panic", 0],
  ["replayEntry", "panic", 0],
  ["domainRestore", "oom", 0],
  ["domainRevive", "panic", 0],
] as const) {
  test(`a spare's ${name} that ${kind === "refuse" ? "refuses" : kind === "oom" ? "runs out of memory" : "panics"} gives the move up`, async (t) => {
    const state = instrument(t);
    const c = await createCodegen(module);
    const d = { ...setUp(c), made: [] as number[] };
    state.fault = { instance: 1, name, kind, skip };
    let progress = await startMove(c);
    let calls = 0;
    while (progress === "moving") {
      progress = c.compactStep(NO_TIME);
      // Catch-up's calls: an add, and a revival that restores first.
      if (calls < 7) {
        call(c, d, calls++);
      }
    }

    assert.equal(progress, "none");
    const usage = c.usage();
    assert.equal(usage.moves.completed, 0);
    assert.equal(usage.moves.aborted[kind === "refuse" ? "refused" : "spare"], 1);
    assert.equal(usage.failedMoves, 1);
    assert.equal(state.fault, null, "the fault was injected");
    // The old instance goes on as it was, and a later move completes.
    for (; calls < 20; calls++) {
      call(c, d, calls);
    }

    await startMove(c);
    assert.equal(c.compact(), true);
    assert.equal(c.usage().moves.completed, 1);
    assert.deepEqual(outcome(c, d.added), await twin(calls));
  });
}

test("a large domain wanted in place moves, and is rebuilt in place once a move is refused", async (t) => {
  const state = instrument(t);
  const c = await createCodegen(module);
  setUp(c);
  for (let i = 0; i < 2; i++) {
    assert.equal(c.add(playerglobalLibrary, true, c.childDomain(0)), 0);
  }

  assert.ok(c.usage().live > 4 << 20, `live ${c.usage().live}`);
  state.want = "in place";
  state.fault = { instance: 1, name: "domainLoad", kind: "refuse", skip: 0 };
  assert.equal(await startMove(c), "none");
  assert.equal(state.inPlace, 0);
  assert.equal(c.usage().moves.aborted.refused, 1);
  assert.notEqual(c.compactStep(NO_TIME), "moving");
  assert.equal(state.inPlace, 1);
  assert.equal(c.usage().moves.started, 1);
});

test("a call that cannot be journaled gives the move up", async (t) => {
  const state = instrument(t);
  const c = await createCodegen(module);
  const d = { ...setUp(c), made: [] as number[] };
  await startMove(c);
  c.compactStep(NO_TIME);
  // A compile whose log could not be read: the spare could not replay it.
  state.fault = { instance: 0, name: "journalBytes", kind: "refuse", skip: 0 };
  c.compileModule([], 2);
  assert.equal(c.compactStep(NO_TIME), "none");
  assert.equal(c.usage().moves.aborted.unjournaled, 1);
  assert.equal(c.usage().failedMoves, 0);
  // A finding outside the finder's chain, which is not journaled.
  await startMove(c);
  c.found({ domain: d.kept, nsKind: 0, uri: "", name: "x", abc: 3, asType: false });
  assert.equal(c.usage().moves.aborted.unjournaled, 2);
});

test("a reset meanwhile supersedes the move", async (t) => {
  instrument(t);
  const c = await createCodegen(module);
  setUp(c);
  await startMove(c);
  c.reset();
  assert.equal(c.usage().moves.aborted.superseded, 1);
});

test("a recovery from a panic of the old instance meanwhile supersedes the move", async (t) => {
  instrument(t);
  const c = await createCodegen(module);
  const d = { ...setUp(c), made: [] as number[] };
  await startMove(c);
  c.compactStep(NO_TIME);
  call(c, d, 0);
  assert.equal(c.add(PANIC), 1107);
  assert.equal(c.usage().moves.aborted.superseded, 1);
  assert.deepEqual(outcome(c, d.added), await twin(1));
});

test("a revival that rebuilds the old instance in place meanwhile supersedes the move", async (t) => {
  instrument(t);
  const c = await createCodegen(module);
  const d = { ...setUp(c), made: [] as number[] };
  // A first move lets go of the evicted child's ABCs, which a revival then
  // gives back, and links again by a rebuild in place.
  await startMove(c);
  assert.equal(c.compact(), true);
  await startMove(c);
  c.compactStep(NO_TIME);
  call(c, d, 2);
  assert.equal(c.usage().moves.aborted.superseded, 1);
  assert.equal(c.usage().moves.completed, 1);
  const twinned = await createCodegen(module);
  const e = { ...setUp(twinned), made: [] as number[] };
  call(twinned, e, 2);
  assert.deepEqual(outcome(c, d.added), outcome(twinned, e.added));
});

test("compact finishes a move compactStep has under way", async (t) => {
  instrument(t);
  const c = await createCodegen(module);
  const d = { ...setUp(c), made: [] as number[] };
  await startMove(c);
  for (let i = 0; i < 5; i++) {
    c.compactStep(NO_TIME);
    call(c, d, i);
  }

  const memory = c.memoryBytes();
  assert.equal(c.compact(), true);
  assert.equal(c.usage().moves.completed, 1);
  assert.ok(c.memoryBytes() < memory, "the domain moved to a smaller instance");
  assert.deepEqual(outcome(c, d.added), await twin(5));
});
