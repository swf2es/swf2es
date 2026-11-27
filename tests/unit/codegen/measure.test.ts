// What the test builds measure for the design of arenas per application
// domain (packages/codegen/zig/src/testing/measure.zig): the memory
// report, the pinned rebuild policy, rebuilds a kind of work a step, the
// count of findings outside the finder's chain, and the probe of ids that
// skip. Each test on an instance of its own, as these set what lasts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinLibrary } from "../../../packages/player/dist/playerglobal/libraries.js";
import { classes, METHOD, mn } from "./link-cases.ts";
import { loadTesting, TESTED } from "./testing-module.ts";

const SWF_31 = 50;
const layered = classes(
  [{ name: mn("A"), base: mn("Object"), traits: [{ name: mn("m"), kind: METHOD }] }],
  true,
);

/** The report's line that starts with `word`, its fields by name. */
function line(report: string, word: string): Record<string, number> {
  const found = report.split("\n").find((l) => l.startsWith(`${word} `));
  assert.ok(found, `no ${word} line`);
  return Object.fromEntries(
    found
      .split(" ")
      .slice(1)
      .map((field) => field.split("="))
      .map(([name, value]) => [name, Number(value)]),
  );
}

test("the report counts a dropped domain's ABC, its parse block, link arrays and rows as dead", async () => {
  const t = await loadTesting(TESTED);
  t.domainReset(SWF_31);
  assert.equal(t.domainAdd(builtinLibrary, true), 0);
  const child = t.domainChild(0);
  assert.equal(t.domainAdd(layered, false, child), 0);
  assert.notEqual(t.domainModule("", -1, false), "");
  const before = line(t.domainMemoryReport(), "abcs");
  assert.equal(before.dead, 0);

  t.domainDrop(child);
  const report = t.domainMemoryReport();
  const abcs = line(report, "abcs");
  assert.deepEqual([abcs.live, abcs.dead, abcs.vacated], [1, 1, 0]);
  assert.ok(abcs.dead_parse > 0 && abcs.dead_link > 0 && abcs.dead_rows > 0);
  assert.equal(abcs.live_parse + abcs.dead_parse, before.live_parse);
  assert.ok(line(report, "space traits").dead > 0);
  assert.ok(line(report, "tables").bytes > 0);
  assert.ok(line(report, "arena").domain >= line(report, "tables").bytes);
});

test("a pinned policy answers from the weights alone, with memory the size pinned", async () => {
  const t = await loadTesting(TESTED);
  t.domainPinPolicy(64);
  t.domainReset(SWF_31);
  assert.equal(t.domainAdd(builtinLibrary, true), 0);
  assert.equal(Number(t.domainUsage().split(" ")[2]), 64 << 20);
  t.domainPinPolicy(0);
  assert.equal(Number(t.domainUsage().split(" ")[2]), t.memory.buffer.byteLength);
});

test("a rebuild a kind of work a step builds the same domain, and says what each step did", async () => {
  const run = async (phases: boolean) => {
    const t = await loadTesting(TESTED);
    t.domainRebuildPhases(phases);
    t.domainReset(SWF_31);
    assert.equal(t.domainAdd(builtinLibrary, true), 0);
    assert.equal(t.domainAdd(layered, false, t.domainChild(0)), 0);
    t.domainVerifyAll();
    assert.ok(t.domainRebuild(true));
    const kinds = new Set<number>();
    let steps = 0;
    let step = 0;
    do {
      step = t.domainRebuildStep();
      steps++;
      const [phase, abcs, bytes, cost, replays, kept] = (t.domainRebuildStepWork() as string)
        .split(" ")
        .map(Number);
      kinds.add(phase);
      if (phases) {
        // One kind a step: the other kinds' counts none.
        const others = [abcs + bytes, cost, replays + kept].filter((_, k) => k !== phase - 1);
        assert.deepEqual(
          others,
          [0, 0],
          `step ${steps}: ${phase} ${abcs} ${bytes} ${cost} ${replays}`,
        );
      }
    } while (step === 0);

    assert.equal(step, 1);
    return { summary: t.domainSummary(), module: t.domainModule("", -1, false), kinds, steps };
  };

  const plain = await run(false);
  const phased = await run(true);
  assert.equal(phased.summary, plain.summary);
  assert.equal(phased.module, plain.module);
  assert.ok(phased.kinds.has(1) && phased.kinds.has(2));
  assert.ok(phased.steps >= plain.steps);
});

test("a finding of an ABC outside the finder's chain is counted, and panics when strict", async () => {
  const t = await loadTesting(TESTED);
  t.domainReset(SWF_31);
  assert.equal(t.domainAdd(builtinLibrary, true), 0);
  const child = t.domainChild(0);
  assert.equal(t.domainAdd(layered, false, child), 0);
  t.domainFound(child, 0, "", "A", 1, true);
  assert.equal(t.domainOutsideFindings(), 0);
  t.domainFound(0, 0, "", "A", 1, true);
  assert.equal(t.domainOutsideFindings(), 1);
  t.domainStrictFindings(true);
  assert.throws(() => t.domainFound(0, 0, "", "A", 1, true), /outside the finder's chain/);

  // A reset counts afresh.
  const fresh = await loadTesting(TESTED);
  fresh.domainReset(SWF_31);
  fresh.domainAdd(builtinLibrary, true);
  fresh.domainAdd(layered, false, fresh.domainChild(0));
  fresh.domainFound(0, 0, "", "A", 1, true);
  assert.equal(fresh.domainOutsideFindings(), 1);
  fresh.domainReset(SWF_31);
  assert.equal(fresh.domainOutsideFindings(), 0);
});

test("with ids that skip, every ABC still links and compiles, and a rebuild keeps the log", async () => {
  const t = await loadTesting(TESTED);
  t.domainGapProbe(64);
  t.domainReset(SWF_31);
  assert.equal(t.domainAdd(builtinLibrary, true), 0);
  assert.equal(t.domainAdd(layered, false, t.domainChild(0)), 0);
  const module = t.domainModule("", -1, false);
  assert.notEqual(module, "");
  // The second ABC's one class after the first's, from the next multiple of 64.
  const length = (table: string) =>
    Number(new RegExp(`^rows ${table} len=(\\d+)`, "m").exec(t.domainMemoryReport())?.[1]);
  assert.equal(length("classAbc") % 64, 1);

  // The log is not paged, so that a rebuild replays no entry twice.
  const log = length("logKind");
  assert.ok(t.domainRebuild(false));
  assert.equal(length("logKind"), log);
  assert.equal(t.domainModule("", -1, false), module);
});
