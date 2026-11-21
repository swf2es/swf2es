// The renderer census's counting (tests/player/census.ts) on frames planned by the planner itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Commands,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  NORMAL,
  plan,
  Rows,
  RUN,
  SCREEN,
  SceneList,
  STENCIL_PUSH,
} from "../../../packages/render/dist/index.js";
import {
  analyseFrame,
  type BlendMemory,
  type CensusInput,
  dirtyMarks,
  FORM_FILL,
  FORM_FRESH,
  FORM_GLYPHS,
  FORM_SMALL,
  formatCensus,
  framesFrom,
  summarise,
  walkCensus,
} from "../../player/census.ts";

/**
 * A frame of `scene`, its rows and its geometries' boxes, planned, each entry a small fill unless
 * `form` says otherwise, and no runs gathered yet.
 */
function frame(
  scene: SceneList,
  rows: Rows,
  boxes: number[],
  options: { form?: number[]; multi?: boolean } = {},
): CensusInput {
  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  const form = new Uint8Array(scene.length).fill(FORM_FILL | FORM_SMALL);
  for (const [i, f] of (options.form ?? []).entries()) {
    form[i] = f;
  }

  return {
    ops: commands.ops,
    commandCount: commands.length,
    params: commands.params,
    kind: scene.kind,
    geometry: scene.geometry,
    row: scene.row,
    texture: scene.texture,
    sampler: scene.sampler,
    form,
    boxes: new Float32Array(boxes),
    rows: rows.data,
    scale: 1,
    multi: options.multi ?? true,
    subRuns: new Int32Array(0),
    subRunCount: 0,
    direct: new Set(),
  };
}

/** The index of the `n`-th command of opcode `op` (from 0). */
function commandOf(input: CensusInput, op: number, n = 0): number {
  for (let k = 0; k < input.commandCount; k++) {
    if (input.ops[k * 4] === op && n-- === 0) {
      return k;
    }
  }

  throw new Error(`no command ${op}`);
}

/** Geometry boxes: geometry k a 10-unit square at the origin. */
const squares = (count: number) => Array.from({ length: count }, () => [0, 0, 10, 10]).flat();

test("runs are counted by length, merging and what ended them", () => {
  const scene = new SceneList();
  const rows = new Rows();
  const row = rows.add(1, 0, 0, 1, 0, 0, null);
  for (let i = 0; i < 40; i++) {
    scene.draw(i, row, NORMAL);
  }

  scene.keptLayer(0, NORMAL, row, 0, 0, 10, 10);
  for (let i = 0; i < 10; i++) {
    scene.draw(40 + i, row, NORMAL);
  }

  const input = frame(scene, rows, squares(50));
  const first = commandOf(input, RUN);
  const second = commandOf(input, RUN, 1);
  input.subRuns = Int32Array.from([first, 0, 39, 40, 1, 0, second, 41, 50, 10, 0, 0]);
  input.subRunCount = 2;
  const { counts } = analyseFrame(input, null);
  assert.equal(counts.runs, 2);
  assert.equal(counts["runs.draws"], 50);
  assert.equal(counts["runs.merged"], 1);
  assert.equal(counts["runs.merged.draws"], 40);
  assert.equal(counts["runs.short.draws"], 10);
  assert.equal(counts["runs.length.32-63"], 1);
  assert.equal(counts["runs.length.8-15"], 1);
  assert.equal(counts["runs.end.kept output composite"], 1);
  assert.equal(counts["runs.end.frame end"], 1);
  assert.equal(counts["filter.composites"], 1);
  // The 10 fills not merged, all of geometries of their own.
  assert.equal(counts["repeat.draws"], 10);
  assert.equal(counts["repeat.adjacent"], undefined);
});

test("a run split inside its command is ended by what it did not take", () => {
  const scene = new SceneList();
  const rows = new Rows();
  const row = rows.add(1, 0, 0, 1, 0, 0, null);
  for (let i = 0; i < 12; i++) {
    scene.draw(i, row, NORMAL);
  }

  const form = Array(12).fill(FORM_FILL | FORM_SMALL);
  form[3] = FORM_GLYPHS;
  form[8] = FORM_FILL | FORM_SMALL | FORM_FRESH;
  const runs = (multi: boolean, sub: number[][]) => {
    const input = frame(scene, rows, squares(12), { form, multi });
    const k = commandOf(input, RUN);
    input.subRuns = Int32Array.from(sub.flatMap(([a, b]) => [k, a, b, b - a + 1, 0, 0]));
    input.subRunCount = sub.length;
    return analyseFrame(input, null).counts;
  };

  // 0-2, then a glyph run at 3; 4-5, then the texture slots full; 6-7, a fresh one after, then
  // 8-11 to the frame's end.
  const multi = runs(true, [
    [0, 2],
    [4, 5],
    [6, 7],
    [8, 11],
  ]);
  assert.equal(multi["runs.end.glyphs"], 1);
  assert.equal(multi["runs.end.texture slots"], 2);
  assert.equal(multi["runs.end.frame end"], 1);
  const single = runs(false, [
    [0, 2],
    [4, 5],
    [6, 7],
    [8, 11],
  ]);
  assert.equal(single["runs.end.texture slots"], 1);
  assert.equal(single["runs.end.fresh or stable split"], 1);
});

test("repeats join earlier draws of their geometry past draws they do not overlap", () => {
  const scene = new SceneList();
  const rows = new Rows();
  const here = rows.add(1, 0, 0, 1, 0, 0, null);
  const far = rows.add(1, 0, 0, 1, 100, 0, null);
  // A A B A, B far away: the second A adjacent, the last commuting past B.
  scene.draw(0, here, NORMAL);
  scene.draw(0, here, NORMAL);
  scene.draw(1, far, NORMAL);
  scene.draw(0, here, NORMAL);
  // Then A B' A with B' over A: the last A cannot join.
  scene.draw(0, here, NORMAL);
  scene.draw(2, here, NORMAL);
  scene.draw(0, here, NORMAL);
  const input = frame(scene, rows, squares(3));
  const k = commandOf(input, RUN);
  input.subRuns = Int32Array.from([k, 0, 3, 4, 0, 0, k, 4, 6, 3, 0, 0]);
  input.subRunCount = 2;
  const { counts } = analyseFrame(input, null);
  assert.equal(counts["repeat.draws"], 7);
  assert.equal(counts["repeat.adjacent"], 1);
  assert.equal(counts["repeat.commuting"], 2);
  // Every A after the first, wherever it is in the frame.
  assert.equal(counts["repeat.frame"], 4);
  assert.equal(counts["repeat.large"], undefined);
});

test("runs a normal composite alone came between are joined in the projection", () => {
  const scene = new SceneList();
  const rows = new Rows();
  const row = rows.add(1, 0, 0, 1, 0, 0, null);
  // 20 fills, a kept output, 20, another, 20, then one in screen mode, then 20.
  for (let part = 0; part < 4; part++) {
    for (let i = 0; i < 20; i++) {
      scene.draw(i, row, NORMAL);
    }

    scene.keptLayer(part, part === 2 ? SCREEN : NORMAL, row, 0, 0, 10, 10);
  }

  const input = frame(scene, rows, squares(20));
  input.subRuns = Int32Array.from(
    [0, 1, 2, 3].flatMap((n) => [commandOf(input, RUN, n), n * 21, n * 21 + 19, 20, 0, 0]),
  );
  input.subRunCount = 4;
  const { counts } = analyseFrame(input, null);
  assert.equal(counts["runs.short.draws"], 80);
  // The first three joined by two quads, the screen composite ending them; the last alone.
  assert.equal(counts["joined.runs"], 2);
  assert.equal(counts["joined.quads"], 2);
  assert.equal(counts["joined.mergeable"], 62);
  assert.equal(counts["joined.subDraws"], 21);
});

test("masks' runs are counted apart", () => {
  const scene = new SceneList();
  const rows = new Rows();
  const row = rows.add(1, 0, 0, 1, 0, 0, null);
  scene.marker(MASK_BEGIN);
  scene.draw(0, row, NORMAL);
  scene.marker(MASK_USE, 1, 1);
  scene.draw(1, row, NORMAL);
  scene.marker(MASK_POP, 1, 1);
  const input = frame(scene, rows, squares(2));
  const k = commandOf(input, STENCIL_PUSH);
  const run = commandOf(input, RUN);
  input.subRuns = Int32Array.from([k, 1, 1, 1, 1, 1, run, 3, 3, 1, 0, 0]);
  input.subRunCount = 2;
  const { counts } = analyseFrame(input, null);
  assert.equal(counts["masks.runs"], 1);
  assert.equal(counts["masks.merged.draws"], 1);
  assert.equal(counts.runs, 1);
  // The projection's "now" leaves the mask's sub-draw out, as its runs leave masks out.
  const lines = formatCensus(
    summarise([{ ...counts, "path.merged": 1, "path.multi": 1, "joined.runs": 1 }]),
  );
  assert.match(lines.find((line) => line.includes("if joined")) ?? "", /\(now 1 of fills/);
});

/**
 * A frame of one screen layer of `geometries`, its draws at `x`, `y`, their run gathered whole,
 * and drawn straight onto the stage where `direct`.
 */
function blendFrame(geometries: number[], x: number, y: number, direct = false): CensusInput {
  const scene = new SceneList();
  const rows = new Rows();
  const row = rows.add(1, 0, 0, 1, x, y, null);
  const layer = scene.layerBegin();
  scene.layerRect(layer, Math.floor(x), Math.floor(y), 20, 20);
  for (const g of geometries) {
    scene.draw(g, row, NORMAL);
  }

  scene.layerEnd(SCREEN, -1);
  const input = frame(scene, rows, squares(4));
  const k = commandOf(input, RUN);
  input.subRuns = Int32Array.from([k, 1, geometries.length, geometries.length, 0, 0]);
  input.subRunCount = 1;
  if (direct) {
    // The layer's push, before its run.
    input.direct = new Set([k - 1]);
  }

  return input;
}

test("blend layers are counted by content, and kept content found again", () => {
  const first = analyseFrame(blendFrame([0, 1, 2], 10, 10), null);
  assert.equal(first.counts["blend.layers"], 1);
  assert.equal(first.counts["blend.layers.draws"], 3);
  assert.equal(first.counts["blend.inside.2-4"], 1);
  assert.equal(first.counts["blend.layers.area"], 400);
  assert.equal(first.counts["blend.mode.screen"], 1);
  assert.equal(first.counts["blend.unchanged.still"], undefined);
  assert.equal(first.counts["runs.end.blend layer ends"], 1);

  const after = (input: CensusInput, memory: BlendMemory) => analyseFrame(input, memory).counts;
  assert.equal(after(blendFrame([0, 1, 2], 10, 10), first.memory)["blend.unchanged.still"], 1);
  assert.equal(after(blendFrame([0, 1, 2], 13, 8), first.memory)["blend.unchanged.whole"], 1);
  assert.equal(after(blendFrame([0, 1, 2], 10.5, 10), first.memory)["blend.unchanged.moved"], 1);
  const changed = after(blendFrame([0, 1, 3], 10, 10), first.memory);
  assert.equal(changed["blend.layers"], 1);
  assert.equal(
    Object.keys(changed).some((key) => key.startsWith("blend.unchanged")),
    false,
  );

  const direct = analyseFrame(blendFrame([0], 10, 10, true), null).counts;
  assert.equal(direct["blend.direct"], 1);
  assert.equal(direct["blend.layers"], undefined);
  assert.equal(direct.runs, undefined);
});

/**
 * A frame of one screen layer of a fill at the origin and, inside it, kept output 3 at `x`, `y`,
 * or a filtered layer drawn anew there (held) where `held`.
 */
function keptFrame(x: number, y: number, held = false): CensusInput {
  const scene = new SceneList();
  const rows = new Rows();
  const row = rows.add(1, 0, 0, 1, 0, 0, null);
  const layer = scene.layerBegin();
  scene.layerRect(layer, 0, 0, 40, 40);
  scene.draw(0, row, NORMAL);
  if (held) {
    const filtered = scene.layerBegin(2);
    scene.layerRect(filtered, x, y, 10, 10);
    scene.draw(0, rows.add(1, 0, 0, 1, x, y, null), NORMAL);
    scene.layerEnd(NORMAL, -1, 0);
  } else {
    scene.keptLayer(3, NORMAL, row, x, y, 10, 10);
  }

  scene.layerEnd(SCREEN, -1);
  return frame(scene, rows, squares(1));
}

test("a kept output inside a blend layer is its content, a filter drawn anew changes it", () => {
  const first = analyseFrame(keptFrame(5, 5), null);
  assert.equal(first.counts["blend.layers"], 1);
  assert.equal(first.counts["filter.composites"], 1);
  const again = analyseFrame(keptFrame(5, 5), first.memory).counts;
  assert.equal(again["blend.unchanged.still"], 1);
  // The output moved within the layer: other content.
  const moved = analyseFrame(keptFrame(7, 5), first.memory).counts;
  assert.equal(
    Object.keys(moved).some((key) => key.startsWith("blend.unchanged")),
    false,
  );

  const held = analyseFrame(keptFrame(5, 5, true), null);
  assert.equal(held.counts["filter.held"], 1);
  assert.equal(held.counts["blend.refiltered"], 1);
  const heldAgain = analyseFrame(keptFrame(5, 5, true), held.memory).counts;
  assert.equal(heldAgain["blend.refiltered"], 1);
  assert.equal(heldAgain["blend.unchanged.still"], undefined);
});

test("the walk is counted against what it visited, what it did not apart", () => {
  const leaf = (dirty = 0) => ({ dirty });
  const moved = { dirty: 1, children: [leaf(), leaf()] };
  // Hidden: its subtree changed, but the walk passes it over.
  const hidden = { dirty: 0, descendantsDirty: true, children: [leaf(4), leaf(4), leaf(4)] };
  const root = { dirty: 0, descendantsDirty: true, children: [moved, hidden] };
  const marks = dirtyMarks(root);
  const walked = new Set([root, moved, ...moved.children]);
  assert.deepEqual(walkCensus(marks, { calls: 5, objects: walked, hidden: 1, masks: 0 }), {
    "walk.calls": 5,
    "walk.visited": 4,
    "walk.again": 1,
    "walk.hidden": 1,
    "walk.masks": 0,
    "walk.copied": 0,
    "walk.dirty": 1,
    "walk.transform": 1,
    "walk.needed": 4,
    "walk.unwalked": 4,
    "walk.unwalkedDirty": 3,
    "walk.rowsOnly": 1,
  });

  // Walked, the content changes make the frame more than rows.
  const all = new Set(marks.keys());
  const counts = walkCensus(marks, { calls: 8, objects: all, hidden: 0, masks: 0 });
  assert.equal(counts["walk.needed"], 8);
  assert.equal(counts["walk.content"], 3);
  assert.equal(counts["walk.rowsOnly"], 0);
  assert.ok(counts["walk.needed"] <= counts["walk.visited"]);
});

test("frames are taken by their tags, and none is an error", () => {
  const records = [
    { frame: 2, runs: 1 },
    { frame: 12, runs: 2 },
    { frame: 14, runs: 4 },
  ];
  assert.deepEqual(framesFrom(records, 12), [{ runs: 2 }, { runs: 4 }]);
  assert.throws(() => framesFrom(records, 20), /no frame/);
});

test("frames are averaged, and the report names what it counted", () => {
  const summary = summarise([
    { runs: 2, "runs.draws": 10, "path.multi": 8 },
    { runs: 4, "runs.draws": 30, "path.multi": 12, "path.merged": 2 },
  ]);
  assert.deepEqual(summary, {
    frames: 2,
    runs: 3,
    "runs.draws": 20,
    "path.multi": 10,
    "path.merged": 1,
  });
  const lines = formatCensus(summary);
  assert.match(lines[0], /over 2 frames/);
  assert.match(lines[1], /sub-draws +11: merged 1, multi-draw 10/);
  assert.match(lines[2], /fill runs +3 of 20 fills/);
});
