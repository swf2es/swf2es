// The budget of an idle pool: grown by what it let go for room and was
// asked for again, never past its ceiling, and shrunk back once nothing is.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deviceMemory,
  IdleBudget,
  LINES_IDLE_VERTICES,
  LINES_IDLE_VERTICES_MOST,
  linesCeiling,
} from "../../../../packages/player/dist/render/pools.js";

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

test("the lines' ceiling follows the device's memory and heap, within the floor and the most", () => {
  // Telling nothing, as node and a browser without either: the most.
  assert.equal(linesCeiling({}), LINES_IDLE_VERTICES_MOST);

  // Half a million vertices a GB of memory.
  assert.equal(linesCeiling({ deviceMemory: 2 }), 1_000_000);
  assert.equal(linesCeiling({ deviceMemory: 4 }), 2_000_000);
  assert.equal(linesCeiling({ deviceMemory: 8 }), LINES_IDLE_VERTICES_MOST);
  assert.equal(linesCeiling({ deviceMemory: 0.5 }), LINES_IDLE_VERTICES);

  // An eighth of the heap's limit at 110 bytes a vertex: 1 GiB is some 1.2 million.
  assert.equal(linesCeiling({ heapLimit: 2 ** 30 }), Math.floor(2 ** 30 / 8 / 110));
  assert.equal(linesCeiling({ heapLimit: 4 * 2 ** 30 }), LINES_IDLE_VERTICES_MOST);
  assert.equal(linesCeiling({ heapLimit: 2 ** 28 }), LINES_IDLE_VERTICES);

  // The less of the two where both are told.
  assert.equal(
    linesCeiling({ deviceMemory: 8, heapLimit: 2 ** 30 }),
    Math.floor(2 ** 30 / 8 / 110),
  );
  assert.equal(linesCeiling({ deviceMemory: 2, heapLimit: 4 * 2 ** 30 }), 1_000_000);
});

test("the device's memory is read where a host tells it, and nothing taken from one that does not", () => {
  const host = globalThis as { navigator?: unknown; performance: { memory?: unknown } };
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    assert.deepEqual(deviceMemory(), { deviceMemory: undefined, heapLimit: undefined });

    Object.defineProperty(globalThis, "navigator", {
      value: { deviceMemory: 4 },
      configurable: true,
    });
    host.performance.memory = { jsHeapSizeLimit: 2 ** 31 };
    assert.deepEqual(deviceMemory(), { deviceMemory: 4, heapLimit: 2 ** 31 });

    // Nonsense is no answer.
    Object.defineProperty(globalThis, "navigator", {
      value: { deviceMemory: "4" },
      configurable: true,
    });
    host.performance.memory = { jsHeapSizeLimit: 0 };
    assert.deepEqual(deviceMemory(), { deviceMemory: undefined, heapLimit: undefined });
  } finally {
    delete host.performance.memory;
    if (navigator) {
      Object.defineProperty(globalThis, "navigator", navigator);
    }
  }
});
