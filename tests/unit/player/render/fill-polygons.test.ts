import assert from "node:assert/strict";
import { test } from "node:test";
import { crossingFill } from "../../../../packages/player/dist/render/fill-polygons.js";

const square = (x: number, y: number, size: number) => [
  x,
  y,
  x + size,
  y,
  x + size,
  y + size,
  x,
  y + size,
];

function area(points: number[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    sum += points[j] * points[i + 1] - points[i] * points[j + 1];
  }

  return Math.abs(sum / 2);
}

test("simple, disjoint and nested contours keep the containment path", () => {
  for (const contours of [
    [square(0, 0, 20)],
    [square(0, 0, 20), square(30, 0, 20)],
    [square(0, 0, 20), square(5, 5, 10)],
  ]) {
    assert.equal(crossingFill(contours, false), null);
  }
});

test("overlapping, identical and self-crossing contours cover each filled region once", () => {
  const a = square(0, 0, 20);
  const b = square(10, 10, 20);
  const reversed = [10, 10, 10, 30, 30, 30, 30, 10];
  for (const [contours, nonZero, expected] of [
    [[a, b], false, 600],
    [[a, b], true, 700],
    [[a, reversed], true, 600],
    [[a, a], false, 0],
    [[a, a], true, 400],
    [[a, square(20, 0, 20)], false, 800],
    [[[0, 0, 10, 10, 0, 10, 10, 0]], false, 50],
    [[[0, 0, 10, 0, 0, 0]], false, 0],
  ] as [number[][], boolean, number][]) {
    const polygons = crossingFill(contours, nonZero);
    assert.notEqual(polygons, null);
    assert.equal(
      polygons?.reduce((sum, points) => sum + area(points), 0),
      expected,
    );
  }
});

test("a crossing rounded just below a vertex does not hide the vertex's outgoing edges", () => {
  const polygons = crossingFill(
    [square(0, 0, 256), [56, -64, 26, 175, 86, 175], [200, -64, 170, 175, 230, 175]],
    false,
  );
  assert.ok(polygons);
  for (const [x, y, expected] of [
    [5, 100, 1],
    [56, 100, 0],
    [200, 100, 0],
    [120, 100, 1],
  ]) {
    assert.equal(polygons.filter((points) => winding(points, x, y) !== 0).length, expected);
  }
});

/** Signed ray crossings, independent of the tessellator's horizontal bands. */
function winding(points: number[], x: number, y: number): number {
  let sum = 0;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const side =
      (points[i] - points[j]) * (y - points[j + 1]) -
      (x - points[j]) * (points[i + 1] - points[j + 1]);
    if (points[j + 1] <= y && points[i + 1] > y && side > 0) {
      sum++;
    } else if (points[j + 1] > y && points[i + 1] <= y && side < 0) {
      sum--;
    }
  }

  return sum;
}

test("crossing polygons preserve both winding rules without overlapping output spans", () => {
  let seed = 7;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let n = 0; n < 100; n++) {
    const contours = [square(0, 0, 20), square(10, 10, 20)];
    for (let i = 0; i < 3; i++) {
      contours.push(Array.from({ length: 16 }, () => Math.floor(rand() * 40)));
    }

    for (const nonZero of [false, true]) {
      const polygons = crossingFill(contours, nonZero);
      assert.ok(polygons);
      for (let i = 0; i < 300; i++) {
        const x = rand() * 40;
        const y = rand() * 40;
        const sum = contours.reduce((sum, points) => sum + winding(points, x, y), 0);
        const expected = nonZero ? sum !== 0 : sum % 2 !== 0;
        const covered: number = polygons.filter((points) => winding(points, x, y) !== 0).length;
        assert.equal(covered, Number(expected), `case ${n}, ${nonZero}, (${x},${y})`);
      }
    }
  }
});
