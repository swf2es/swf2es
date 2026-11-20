// Spans of a scene list compared (docs/renderer.md, "Spans"): the view's
// checked mode walks what a span it kept from a frame before stands for,
// and has this say, entry for entry and row for row, where the two differ.
import { ROW_FLOATS, type Rows } from "./rows.js";
import {
  BLEND_NAMES,
  DRAW,
  KEPT,
  LAYER_BEGIN,
  LAYER_END,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  type SceneList,
} from "./scene.js";

/** A stretch of a scene list's entries, and of the rows they name, that one subtree wrote. */
export interface Span {
  first: number;
  end: number;
  rowsFirst: number;
  rowsEnd: number;
}

/** A row's floats by name (rows.ts), the two after the translation unused. */
const ROW_NAMES = [
  "a",
  "b",
  "c",
  "d",
  "tx",
  "ty",
  "pad 6",
  "pad 7",
  "rMul",
  "gMul",
  "bMul",
  "aMul",
  "rAdd",
  "gAdd",
  "bAdd",
  "aAdd",
];

const KIND_NAMES: Record<number, string> = {
  [DRAW]: "draw",
  [MASK_BEGIN]: "mask begin",
  [MASK_USE]: "mask use",
  [MASK_POP]: "mask pop",
  [LAYER_BEGIN]: "layer begin",
  [LAYER_END]: "layer end",
  [KEPT]: "kept layer",
};

/** Whether two floats differ, NaN equal to itself, as the same sums make it. */
function differ(x: number, y: number): boolean {
  return x !== y && !(Number.isNaN(x) && Number.isNaN(y));
}

/** Entry `e` of `scene` in words, its row from `rowsFirst` as the span counts it. */
function entry(scene: SceneList, e: number, rowsFirst: number): string {
  const kind = scene.kind[e];
  const row = scene.row[e];
  const blend = scene.blend[e];
  return `${KIND_NAMES[kind] ?? `kind ${kind}`} of geometry ${scene.geometry[e]}, row ${
    kind === DRAW ? `${row - rowsFirst} of the span` : row
  }, blend ${BLEND_NAMES[blend] ?? blend}, texture ${scene.texture[e]}, sampler ${scene.sampler[e]}`;
}

/** Whether entry `i` of span `a` and of span `b` differ, their rows counted from each span's first. */
function entriesDiffer(
  aScene: SceneList,
  i: number,
  a: Span,
  bScene: SceneList,
  j: number,
  b: Span,
): boolean {
  const kind = aScene.kind[i];
  return (
    kind !== bScene.kind[j] ||
    aScene.geometry[i] !== bScene.geometry[j] ||
    (kind === DRAW
      ? aScene.row[i] - a.rowsFirst !== bScene.row[j] - b.rowsFirst
      : aScene.row[i] !== bScene.row[j]) ||
    aScene.blend[i] !== bScene.blend[j] ||
    aScene.texture[i] !== bScene.texture[j] ||
    aScene.sampler[i] !== bScene.sampler[j]
  );
}

/**
 * Where span `b` of `bScene` and `bRows` draws otherwise than span `a` of
 * `aScene` and `aRows`, in words that name each by `aName` and `bName`:
 * their lengths, their first entry and first row that differ, each in full,
 * and how many do; null where they are alike, entry for entry and row for
 * row. A draw's row is compared as the span counts it, from its first.
 */
export function spanDifference(
  aName: string,
  aScene: SceneList,
  aRows: Rows,
  a: Span,
  bName: string,
  bScene: SceneList,
  bRows: Rows,
  b: Span,
): string | null {
  const entries = a.end - a.first;
  const rows = a.rowsEnd - a.rowsFirst;
  const bEntries = b.end - b.first;
  const bRowCount = b.rowsEnd - b.rowsFirst;
  const told: string[] = [];
  if (entries !== bEntries || rows !== bRowCount) {
    told.push(
      `${aName} has ${entries} entries and ${rows} rows, ${bName} ${bEntries} entries and ${bRowCount} rows`,
    );
  }

  let firstEntry = -1;
  let entriesOff = 0;
  for (let k = 0; k < Math.min(entries, bEntries); k++) {
    if (entriesDiffer(aScene, a.first + k, a, bScene, b.first + k, b)) {
      entriesOff++;
      if (firstEntry < 0) {
        firstEntry = k;
      }
    }
  }

  if (firstEntry >= 0) {
    told.push(
      `entry ${firstEntry} of the span (scene entry ${a.first + firstEntry} and ${
        b.first + firstEntry
      }) is a ${entry(aScene, a.first + firstEntry, a.rowsFirst)} in ${aName}, a ${entry(
        bScene,
        b.first + firstEntry,
        b.rowsFirst,
      )} in ${bName}; ${entriesOff} of ${Math.min(entries, bEntries)} entries differ`,
    );
  }

  let firstRow = -1;
  let rowsOff = 0;
  const fields: string[] = [];
  const aData = aRows.data;
  const bData = bRows.data;
  for (let k = 0; k < Math.min(rows, bRowCount); k++) {
    const i = (a.rowsFirst + k) * ROW_FLOATS;
    const j = (b.rowsFirst + k) * ROW_FLOATS;
    let off = false;
    for (let f = 0; f < ROW_FLOATS; f++) {
      if (differ(aData[i + f], bData[j + f])) {
        off = true;
        if (firstRow < 0) {
          fields.push(`${ROW_NAMES[f]} ${aData[i + f]} against ${bData[j + f]}`);
        }
      }
    }

    if (off) {
      rowsOff++;
      if (firstRow < 0) {
        firstRow = k;
      }
    }
  }

  if (firstRow >= 0) {
    told.push(
      `row ${firstRow} of the span (row ${a.rowsFirst + firstRow} and ${
        b.rowsFirst + firstRow
      }) has ${fields.join(", ")} in ${aName} and ${bName}; ${rowsOff} of ${Math.min(
        rows,
        bRowCount,
      )} rows differ`,
    );
  }

  return told.length > 0 ? told.join("; ") : null;
}
