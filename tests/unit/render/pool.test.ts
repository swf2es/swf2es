import assert from "node:assert/strict";
import { test } from "node:test";
import { SizedPool } from "../../../packages/render/dist/webgl/pool.js";

interface Item {
  width: number;
  height: number;
  usedAt: number;
  name: string;
}

const item = (name: string, width: number, height: number): Item => ({
  width,
  height,
  usedAt: 0,
  name,
});

test("a pool gives back its size exactly, the latest freed first, or the smallest that holds it", () => {
  const pool = new SizedPool<Item>((i) => i.width * i.height);
  pool.give(item("a", 32, 32), 1);
  pool.give(item("b", 32, 32), 2);
  pool.give(item("big", 128, 64), 3);
  pool.give(item("msaa", 32, 32), 4, 4);
  assert.equal(pool.bytes, 32 * 32 * 3 + 128 * 64);
  assert.equal(pool.take(32, 32)?.name, "b");
  // Of other samples, only as asked for.
  assert.equal(pool.take(32, 32, 4)?.name, "msaa");
  assert.equal(pool.takeFitting(100, 40)?.name, "big");
  assert.equal(pool.takeFitting(16, 16)?.name, "a");
  assert.equal(pool.take(32, 32), null);
  assert.equal(pool.bytes, 0);
});

test("a frame's end lets go of the idle, then the least lately freed past the budget", () => {
  const pool = new SizedPool<Item>((i) => i.width * i.height);
  pool.give(item("old", 10, 10), 1);
  pool.give(item("mid", 20, 10), 5);
  pool.give(item("new", 10, 10), 9);
  const dropped: string[] = [];
  // Idle past 6 frames at frame 8: "old" alone.
  pool.trim(8, 6, Number.POSITIVE_INFINITY, (i) => dropped.push(i.name));
  assert.deepEqual(dropped, ["old"]);
  // 300 bytes held, 150 allowed: the least lately freed, "mid", goes, and "new" stays.
  pool.trim(9, 60, 150, (i) => dropped.push(i.name));
  assert.deepEqual(dropped, ["old", "mid"]);
  assert.equal(pool.bytes, 100);
  pool.clear((i) => dropped.push(i.name));
  assert.deepEqual(dropped, ["old", "mid", "new"]);
  assert.equal(pool.takeFitting(1, 1), null);
});

test("a fitting target keeps its sample count, dimensions and area budget", () => {
  const pool = new SizedPool<Item>((i) => i.width * i.height);
  pool.give(item("texture", 80, 48), 0);
  pool.give(item("two samples", 80, 48), 0, 2);
  pool.give(item("too narrow", 64, 96), 0, 4);
  pool.give(item("too short", 128, 32), 0, 4);
  pool.give(item("large", 128, 96), 0, 4);
  pool.give(item("fit", 96, 64), 0, 4);

  assert.equal(pool.takeFitting(80, 48, 4, 96 * 64 - 1), null);
  assert.equal(pool.takeFitting(80, 48, 4, 96 * 64)?.name, "fit");
  assert.equal(pool.takeFitting(80, 48, 4, 80 * 48 * 2), null);
  assert.equal(pool.takeFitting(80, 48, 2)?.name, "two samples");
  assert.equal(pool.takeFitting(80, 48)?.name, "texture");
  assert.equal(pool.takeFitting(80, 48, 4)?.name, "large");
  assert.equal(pool.bytes, 64 * 96 + 128 * 32);
});
