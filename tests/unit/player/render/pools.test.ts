// The budget of an idle pool: grown by what it let go for room and was
// asked for again, never past its ceiling, and shrunk back once nothing is.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IdleBudget } from "../../../../packages/player/dist/render/pools.js";

const WINDOW = 30_000;

test("a key let go for room and asked for again grows the budget by its size", () => {
  const budget = new IdleBudget(1000, 4000, WINDOW, 16);
  budget.tick(0);
  budget.evicted("a", 0, 300);
  budget.missed("a", 5000);
  assert.equal(budget.size, 1300);

  // Once: the key is forgotten as it is asked for.
  budget.missed("a", 5001);
  assert.equal(budget.size, 1300);

  // A key never let go, or let go for room, changes nothing.
  budget.missed("b", 5002);
  assert.equal(budget.size, 1300);
});

test("a key age alone would have let go grows nothing", () => {
  const budget = new IdleBudget(1000, 4000, WINDOW, 16);
  budget.evicted("a", 0, 300);
  budget.missed("a", WINDOW);
  assert.equal(budget.size, 1000);

  // Nor one the pool forgot as the window passed.
  budget.evicted("b", 1000, 300);
  budget.tick(WINDOW + 1000);
  assert.equal(budget.remembered, 0);
});

test("the budget never grows past its ceiling", () => {
  const budget = new IdleBudget(1000, 4000, WINDOW, 1024);
  for (let i = 0; i < 100; i++) {
    budget.evicted(`k${i}`, i, 500);
  }

  for (let i = 0; i < 100; i++) {
    budget.missed(`k${i}`, 1000 + i);
    assert.ok(budget.size <= 4000);
  }

  assert.equal(budget.size, 4000);
});

test("only so many keys are remembered, the first let go forgotten first", () => {
  const budget = new IdleBudget(1000, 4000, WINDOW, 2);
  budget.evicted("a", 0, 100);
  budget.evicted("b", 1, 100);
  budget.evicted("c", 2, 100);
  assert.equal(budget.remembered, 2);
  budget.missed("a", 10);
  assert.equal(budget.size, 1000);
  budget.missed("c", 10);
  assert.equal(budget.size, 1100);
});

test("a budget not grown for a window shrinks back to its floor, halving its excess each window", () => {
  const budget = new IdleBudget(1000, 4000, WINDOW, 16);
  budget.tick(0);
  budget.evicted("a", 0, 2000);
  budget.missed("a", 1000);
  assert.equal(budget.size, 3000);

  // Kept while what it grew for may still come back.
  budget.tick(WINDOW);
  budget.tick(WINDOW + 1000);
  assert.equal(budget.size, 3000);

  // Then, quiet, by half a window.
  for (let t = WINDOW + 1000; t <= 2 * WINDOW + 1000; t += 1000) {
    budget.tick(t);
  }

  assert.ok(Math.abs(budget.size - 2000) < 1e-6, `${budget.size}`);

  // Grown again, it holds again for a window.
  budget.evicted("b", 2 * WINDOW, 500);
  budget.missed("b", 2 * WINDOW + 1000);
  const grown = budget.size;
  budget.tick(3 * WINDOW);
  assert.equal(budget.size, grown);

  for (let t = 3 * WINDOW; t <= 20 * WINDOW; t += 5000) {
    budget.tick(t);
    assert.ok(budget.size >= 1000);
  }

  assert.equal(budget.size, 1000);
});

test("small content keeps the floor", () => {
  const budget = new IdleBudget(1000, 4000, WINDOW, 16);
  for (let t = 0; t < 10 * WINDOW; t += 1000) {
    budget.tick(t);
  }

  assert.equal(budget.size, 1000);
});
