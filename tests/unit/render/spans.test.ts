// Spans of the scene list as data (docs/renderer.md, "Spans"): copied from
// one frame's list into another's with their rows moved, and compared as
// the view's checked mode compares a kept span with a walk.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DRAW,
  MULTIPLY,
  NORMAL,
  ROW_FLOATS,
  Rows,
  SceneList,
  type Span,
  spanDifference,
} from "../../../packages/render/dist/index.js";

const RED = { rMul: 1, gMul: 0, bMul: 0, aMul: 1, rAdd: 0, gAdd: 0, bAdd: 0, aAdd: 0 };

/**
 * A walk's writing of a frame: something before, then an object of two
 * draws under one row and a third under a row of its own, at `tx`; its span.
 */
function frame(scene: SceneList, rows: Rows, before: number, tx: number): Span {
  for (let k = 0; k < before; k++) {
    scene.draw(100 + k, rows.add(1, 0, 0, 1, k, 0, null), NORMAL);
  }

  const first = scene.length;
  const rowsFirst = rows.count;
  const row = rows.add(2, 0, 0, 2, tx, 5, null);
  scene.draw(7, row, NORMAL);
  scene.draw(8, row, MULTIPLY, 3, 1);
  scene.draw(9, rows.add(1, 0, 0, 1, tx + 1, 5, RED), NORMAL, 4, 0);
  return { first, end: scene.length, rowsFirst, rowsEnd: rows.count };
}

/** Span `s` of `scene` and `rows` copied after what `to` and `toRows` hold, as a frame keeps it. */
function copy(scene: SceneList, rows: Rows, s: Span, to: SceneList, toRows: Rows): Span {
  const first = to.length;
  const rowsFirst = toRows.append(rows, s.rowsFirst, s.rowsEnd);
  to.appendDraws(scene, s.first, s.end, rowsFirst - s.rowsFirst);
  return { first, end: to.length, rowsFirst, rowsEnd: toRows.count };
}

test("a span is copied into another frame's list with its rows moved", () => {
  const before = new SceneList();
  const beforeRows = new Rows();
  const kept = frame(before, beforeRows, 2, 10);
  const now = new SceneList();
  const nowRows = new Rows();
  for (let k = 0; k < 5; k++) {
    now.draw(50 + k, nowRows.add(1, 0, 0, 1, 0, 0, null), NORMAL);
  }

  const copied = copy(before, beforeRows, kept, now, nowRows);
  assert.deepEqual(copied, { first: 5, end: 8, rowsFirst: 5, rowsEnd: 7 });
  assert.deepEqual(Array.from(now.kind.subarray(5, 8)), [DRAW, DRAW, DRAW]);
  assert.deepEqual(Array.from(now.geometry.subarray(5, 8)), [7, 8, 9]);
  // Rows 2 and 3 of the frame before are 5 and 6 of this one.
  assert.deepEqual(Array.from(now.row.subarray(5, 8)), [5, 5, 6]);
  assert.deepEqual(Array.from(now.blend.subarray(5, 8)), [NORMAL, MULTIPLY, NORMAL]);
  assert.deepEqual(Array.from(now.texture.subarray(5, 8)), [-1, 3, 4]);
  assert.deepEqual(Array.from(now.sampler.subarray(5, 8)), [0, 1, 0]);
  assert.deepEqual(
    Array.from(nowRows.data.subarray(5 * ROW_FLOATS, 7 * ROW_FLOATS)),
    Array.from(beforeRows.data.subarray(2 * ROW_FLOATS, 4 * ROW_FLOATS)),
  );
  assert.equal(
    spanDifference("the kept span", now, nowRows, copied, "the walk", before, beforeRows, kept),
    null,
  );
});

test("a copy grows the lists it is written into", () => {
  const before = new SceneList();
  const beforeRows = new Rows();
  const kept = frame(before, beforeRows, 0, 0);
  const now = new SceneList();
  const nowRows = new Rows();
  for (let k = 0; k < 2000; k++) {
    copy(before, beforeRows, kept, now, nowRows);
  }

  assert.equal(now.length, 6000);
  assert.equal(nowRows.count, 4000);
  assert.equal(now.row[5999], 3999);
  assert.equal(nowRows.data[3999 * ROW_FLOATS + 4], 1);
});

test("a short span and a long one are copied alike, as they are copied differently", () => {
  for (const draws of [1, 3, 4, 63, 64, 65, 200]) {
    const before = new SceneList();
    const beforeRows = new Rows();
    before.draw(1, beforeRows.add(1, 0, 0, 1, 0, 0, null), NORMAL);
    const first = before.length;
    const rowsFirst = beforeRows.count;
    for (let k = 0; k < draws; k++) {
      const row = beforeRows.add(k + 1, 0, 0, 1, k, -k, k % 2 === 0 ? null : RED);
      before.draw(10 + k, row, k % 3 === 0 ? MULTIPLY : NORMAL, k % 5, k % 2);
    }

    const kept = { first, end: before.length, rowsFirst, rowsEnd: beforeRows.count };
    const now = new SceneList();
    const nowRows = new Rows();
    for (let k = 0; k < 3; k++) {
      now.draw(50 + k, nowRows.add(1, 0, 0, 1, 0, 0, null), NORMAL);
    }

    const copied = copy(before, beforeRows, kept, now, nowRows);
    assert.equal(
      spanDifference("the kept span", now, nowRows, copied, "the walk", before, beforeRows, kept),
      null,
      `${draws} draws`,
    );
    assert.deepEqual(
      Array.from(now.row.subarray(copied.first, copied.end)),
      Array.from({ length: draws }, (_, k) => 3 + k),
    );
  }
});

test("a span of boundaries is not copied", () => {
  const before = new SceneList();
  before.layerBegin();
  before.draw(1, 0, NORMAL);
  before.layerEnd(NORMAL, -1);
  assert.throws(() => new SceneList().appendDraws(before, 0, 3, 0), /no draw/);
});

test("draws and rows written only to be compared are taken off", () => {
  const scene = new SceneList();
  const rows = new Rows();
  frame(scene, rows, 1, 0);
  scene.truncate(1);
  rows.truncate(1);
  assert.equal(scene.length, 1);
  assert.equal(rows.count, 1);
  scene.draw(5, rows.add(1, 0, 0, 1, 0, 0, null), NORMAL);
  assert.deepEqual([scene.geometry[1], scene.row[1]], [5, 1]);
});

test("a stale span is told from the walk, where and how", () => {
  // The frame before drew the object at 10; it moved to 12 with no flag set, so its span was kept.
  const before = new SceneList();
  const beforeRows = new Rows();
  const kept = frame(before, beforeRows, 3, 10);
  const now = new SceneList();
  const nowRows = new Rows();
  const walked = frame(now, nowRows, 1, 12);
  const copied = copy(before, beforeRows, kept, now, nowRows);
  const told = spanDifference(
    "the span kept from the frame before",
    now,
    nowRows,
    copied,
    "the walk",
    now,
    nowRows,
    walked,
  );
  assert.ok(told);
  assert.match(told, /^row 0 of the span \(row 3 and 1\) has tx 10 against 12/);
  assert.match(told, /2 of 2 rows differ/);
  assert.doesNotMatch(told, /entry/);
});

test("a draw that differs is told in full, as are lengths", () => {
  const a = new SceneList();
  const aRows = new Rows();
  const kept = frame(a, aRows, 0, 0);
  const b = new SceneList();
  const bRows = new Rows();
  const first = b.length;
  const row = bRows.add(2, 0, 0, 2, 0, 5, null);
  b.draw(7, row, NORMAL);
  b.draw(8, row, MULTIPLY, 6, 1);
  b.draw(9, bRows.add(1, 0, 0, 1, 1, 5, RED), NORMAL, 4, 0);
  b.draw(10, row, NORMAL);
  const walked = { first, end: b.length, rowsFirst: 0, rowsEnd: bRows.count };
  const told = spanDifference("the kept span", a, aRows, kept, "the walk", b, bRows, walked);
  assert.equal(
    told,
    "the kept span has 3 entries and 2 rows, the walk 4 entries and 2 rows; entry 1 of the span " +
      "(scene entry 1 and 1) is a draw of geometry 8, row 0 of the span, blend multiply, texture 3, " +
      "sampler 1 in the kept span, a draw of geometry 8, row 0 of the span, blend multiply, texture 6, " +
      "sampler 1 in the walk; 1 of 3 entries differ",
  );
});

test("a draw naming another row of its span differs, wherever the span lies", () => {
  const a = new SceneList();
  const aRows = new Rows();
  const kept = frame(a, aRows, 4, 0);
  const b = new SceneList();
  const bRows = new Rows();
  const walked = frame(b, bRows, 0, 0);
  assert.equal(spanDifference("kept", a, aRows, kept, "walked", b, bRows, walked), null);
  b.row[walked.first + 2] = walked.rowsFirst;
  assert.match(
    spanDifference("kept", a, aRows, kept, "walked", b, bRows, walked) ?? "",
    /entry 2 of the span .* row 1 of the span, .* in kept, a draw of geometry 9, row 0 of the span/,
  );
});
