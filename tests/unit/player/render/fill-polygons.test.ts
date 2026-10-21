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

test("contour pruning distinguishes a bounding box from the actual convex enclosure", () => {
  const diamond = [50, 0, 100, 50, 50, 100, 0, 50];
  assert.equal(crossingFill([diamond, square(40, 40, 20)], false), null);
  assert.equal(crossingFill([diamond, [40, 40, 40, 60, 60, 60, 60, 40]], true), null);
  assert.ok(crossingFill([diamond, square(10, 10, 80)], false));
  assert.ok(crossingFill([square(0, 0, 100), square(0, 20, 30)], false));

  const outer = square(0, 0, 100);
  const bowtie = [20, 20, 80, 80, 20, 80, 80, 20];
  for (const nonZero of [false, true]) {
    const polygons = crossingFill([outer, bowtie], nonZero);
    assert.ok(polygons);
    for (const [x, y] of [
      [10, 10],
      [50, 30],
      [30, 50],
      [50, 70],
    ]) {
      const sum = winding(outer, x, y) + winding(bowtie, x, y);
      const expected = nonZero ? sum !== 0 : sum % 2 !== 0;
      assert.equal(polygons.filter((p) => winding(p, x, y) !== 0).length, Number(expected));
    }
  }
});

test("scratch reuse and oversized pool release cannot change previously returned geometry", () => {
  const contours = [square(0, 0, 20), square(10, 10, 20)];
  const kept = crossingFill(contours, false);
  assert.ok(kept);
  const expected = structuredClone(kept);
  for (let i = 0; i < 20; i++) {
    crossingFill([square(5, 5, 2)], true);
    crossingFill([square(0, 0, 100), [10, 10, 90, 90, 10, 90, 90, 10]], i % 2 === 0);
    assert.deepEqual(crossingFill(contours, false), expected);
  }

  const large: number[] = [];
  for (let i = 0; i < 4200; i++) {
    const angle = (i * Math.PI) / 2100;
    const r = i % 2 ? 50 : 100;
    large.push(r * Math.cos(angle), r * Math.sin(angle));
  }

  assert.equal(crossingFill([large], false), null);
  assert.deepEqual(kept, expected);
  assert.deepEqual(crossingFill(contours, false), expected);
});

test("dense bands combine coincident edges under both winding rules", () => {
  const contours = Array.from({ length: 100 }, () => square(0, 0, 20));
  assert.deepEqual(crossingFill(contours, false), []);
  const polygons = crossingFill(contours, true);
  assert.ok(polygons);
  assert.equal(
    polygons.reduce((sum, p) => sum + area(p), 0),
    400,
  );
});

test("unrelated contour levels do not fragment unchanged filled spans", () => {
  const contours = [[0, 0, 10, 10, 0, 10, 10, 0]];
  for (let i = 0; i < 300; i++) {
    const x = 20 + i * 4;
    contours.push([x, i + 0.25, x + 2, i + 0.25, x + 2, 700 - i, x, 700 - i]);
  }

  for (const nonZero of [false, true]) {
    const polygons = crossingFill(contours, nonZero);
    assert.ok(polygons);
    assert.equal(polygons.length, 302);
    assert.equal(
      polygons.reduce((sum, points) => sum + area(points), 0),
      50 + contours.slice(1).reduce((sum, points) => sum + area(points), 0),
    );
    for (let i = 0; i < 300; i++) {
      const x = 21 + i * 4;
      for (const y of [i, i + 0.5, 699.75 - i, 700.25 - i]) {
        const expected = winding(contours[i + 1], x, y) !== 0;
        assert.equal(
          polygons.filter((points) => winding(points, x, y) !== 0).length,
          Number(expected),
        );
      }
    }
  }
});

test("the same span boundaries cannot merge across an unfilled band", () => {
  for (const nonZero of [false, true]) {
    const cut = nonZero ? [-5, 10, -5, 20, 15, 20, 15, 10] : [-5, 10, 15, 10, 15, 20, -5, 20];
    const polygons = crossingFill([[0, 0, 10, 0, 10, 30, 0, 30], cut], nonZero);
    assert.ok(polygons);
    assert.equal(
      polygons.reduce((sum, points) => sum + area(points), 0),
      300,
    );
    for (const [x, y, expected] of [
      [5, 5, 1],
      [5, 15, 0],
      [5, 25, 1],
      [-2, 15, 1],
      [12, 15, 1],
    ]) {
      assert.equal(polygons.filter((points) => winding(points, x, y) !== 0).length, expected);
    }
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
