// How the player gives the compiler's compaction its time (Code.compactSoon):
// an idle callback's deadline when the page is idle, one short slice when
// the callback comes on its timeout, which is short while a move is under
// way, and without idle callbacks a timer as often; asked once however
// often a drop or an eviction asks.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactDeadline, CompactProgress } from "@swf2es/codegen";
import { Code } from "../../../../packages/player/dist/scripting/code.js";

/** A Code over a compiler whose compactStep gives `answers` in turn, and the time each call was given. */
function code(answers: CompactProgress[]) {
  const given: number[] = [];
  const codegen = {
    compactStep(deadline: CompactDeadline) {
      given.push(deadline.timeRemaining());
      return answers.shift() ?? "none";
    },
  };
  const made = new Code({ codegen } as never);
  const soon = () => (made as unknown as { compactSoon(): void }).compactSoon();
  return { given, soon };
}

interface Asked {
  run: (deadline: { timeRemaining(): number; didTimeout: boolean }) => void;
  timeout: number;
}

test("idle callbacks give a move their time, or one short slice on their timeout", (t) => {
  const asked: Asked[] = [];
  const global = globalThis as { requestIdleCallback?: unknown };
  global.requestIdleCallback = (run: Asked["run"], options: { timeout: number }) => {
    asked.push({ run, timeout: options.timeout });
  };
  t.after(() => {
    delete global.requestIdleCallback;
  });

  const { given, soon } = code(["moving", "moving", "done"]);
  soon();
  soon();
  assert.equal(asked.length, 1, "asked once");
  assert.equal(asked[0].timeout, 1000);

  // Idle: the callback's own time.
  asked.shift()?.run({ timeRemaining: () => 30, didTimeout: false });
  assert.equal(given[0], 30);
  assert.equal(asked.length, 1, "asked again while moving");
  assert.equal(asked[0].timeout, 100, "with a short timeout");

  // Busy: on its timeout, one slice of a few milliseconds.
  asked.shift()?.run({ timeRemaining: () => 0, didTimeout: true });
  assert.ok(given[1] > 0 && given[1] <= 6, `a slice of ${given[1]} ms`);
  assert.equal(asked[0].timeout, 100);

  asked.shift()?.run({ timeRemaining: () => 0, didTimeout: true });
  assert.equal(asked.length, 0, "done: not asked again");
});

test("without idle callbacks a timer gives a move one slice as often as the timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { given, soon } = code(["moving", "moving", "done"]);
  soon();
  t.mock.timers.tick(0);
  assert.equal(given.length, 1);
  assert.ok(given[0] > 0 && given[0] <= 6);
  t.mock.timers.tick(99);
  assert.equal(given.length, 1, "not before 100 ms");
  t.mock.timers.tick(1);
  assert.equal(given.length, 2);
  t.mock.timers.tick(100);
  assert.equal(given.length, 3);
  t.mock.timers.tick(1000);
  assert.equal(given.length, 3, "done: no more");
});
