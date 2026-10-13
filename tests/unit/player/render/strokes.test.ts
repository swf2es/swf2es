// The lines' contexts kept idle: past their budget the oldest go, and the
// budget grows as content comes back to those it let go.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LINE, MOVE, type ShapeLayer } from "../../../../packages/player/dist/display/shapes.js";
import {
  LINES_IDLE_MOST,
  LINES_IDLE_VERTICES,
} from "../../../../packages/player/dist/render/pools.js";
import { StrokeContexts, UNIT } from "../../../../packages/player/dist/render/strokes.js";

const line = {
  width: 20,
  color: 0xff000000,
  startCap: 0,
  endCap: 0,
  join: 0,
  miterLimit: 3,
  noHScale: false,
  noVScale: false,
  pixelHinting: false,
  noClose: false,
};

function layers(n: number): ShapeLayer[] {
  return Array.from({ length: n }, () => ({
    fills: [],
    strokes: [{ line, paths: [[MOVE, 0, 0, LINE, 10, 0]] }],
  })) as unknown as ShapeLayer[];
}

test("a loop longer than the idle contexts kept grows their budget till it fits", () => {
  const counts = { strokeContexts: 0, strokeReuses: 0 };
  const lines = new StrokeContexts(counts);
  // A loop of more layers than the least budget keeps, each taken and given back in turn.
  const loop = layers(LINES_IDLE_MOST + 512);
  const turn = () => {
    for (const layer of loop) {
      lines.give(lines.take(layer, UNIT, 1));
    }
  };

  turn();
  assert.equal(counts.strokeContexts, loop.length);
  assert.equal(lines.budget.size, LINES_IDLE_VERTICES);

  // The first turns come back to those let go: each grows the budget.
  for (let i = 0; i < 4; i++) {
    turn();
  }

  assert.ok(lines.budget.size > LINES_IDLE_VERTICES);

  // Then the whole loop is kept.
  const made = counts.strokeContexts;
  turn();
  assert.equal(counts.strokeContexts, made);
});

test("content within the least budget leaves it as it is", () => {
  const counts = { strokeContexts: 0, strokeReuses: 0 };
  const lines = new StrokeContexts(counts);
  const loop = layers(64);
  for (let i = 0; i < 4; i++) {
    for (const layer of loop) {
      lines.give(lines.take(layer, UNIT, 1));
    }

    lines.tick();
  }

  assert.equal(counts.strokeContexts, 64);
  assert.equal(lines.budget.size, LINES_IDLE_VERTICES);
});
