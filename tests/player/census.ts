// The renderer's census (bench.ts --census): what the frames a stage drew asked of the renderer,
// counted for the ranking of the renderer's next performance work (docs/renderer.md, "The
// census"). Pure: page.ts reads the frame's commands, scene list and rows, and what the backend
// did with them, from the renderer's own objects, and this module counts from those alone:
//
// - the fill runs the backend gathered (Draws.prepare), their lengths and what ended each;
// - of the fills not merged into one draw, how many repeat a geometry, texture and sampling
//   drawn just before them, or within 64 draws with nothing in between overlapping them;
// - blend layers by what is drawn inside them, and how many hold what they held the frame before;
// - objects the walk visited against objects changed since the last frame (walkCensus).
//
// Each frame's counts are a flat record of numbers, summed over frames and averaged (summarise).
import {
  ADD,
  ALPHA_MASK,
  BLEND_NAMES,
  CLEAR,
  COMPOSITE,
  DRAW,
  FILTER,
  HELD,
  HOLD_POP,
  HOLD_PUSH,
  LAYER,
  LAYER_POP,
  LAYER_PUSH,
  MIRROR,
  MULTIPLY,
  NORMAL,
  REPEAT,
  ROW_FLOATS,
  RUN,
  SCREEN,
  SMOOTH,
  SNAP,
  STENCIL_POP,
  STENCIL_PUSH,
} from "@swf2es/render";

/** What draws an entry (CensusInput.form, its low bits): nothing, as its texture is gone. */
export const FORM_NONE = 0;
/** The fill program, in a run. */
export const FORM_FILL = 1;
/** The glyph program, advanced text's. */
export const FORM_GLYPHS = 2;
/** The mesh program: drawTriangles' meshes and 3D objects' planes. */
export const FORM_MESH = 3;
/** A shader fill's kernel. */
export const FORM_SHADED = 4;
/** The stage fill program, for a fill that samples the stage's pixel, drawn alone. */
export const FORM_STAGE = 5;
const FORM_KIND = 7;
/** Its geometry small enough to be merged (the atlas's Place.batch). */
export const FORM_SMALL = 8;
/** Its geometry added this frame, which merging waits a frame for. */
export const FORM_FRESH = 16;

/** Ints a sub-run takes in CensusInput.subRuns: its command, first and last entry, draws, merged, stencil. */
export const SUB_RUN_INTS = 6;

/** The most fills one call draws (webgl/programs.ts, RUN_MOST). */
const RUN_MOST = 256;
/** The fewest fills a run is merged with where WEBGL_multi_draw is (webgl/draws.ts). */
const MERGED_LEAST_MULTI = 32;
/** How far back a fill may find a draw of its geometry to join, past draws it does not overlap. */
const WINDOW = 64;
/** Target pixels two boxes are kept apart by to count as not overlapping: antialiasing, hairlines. */
const MARGIN = 1;

/** A frame the stage drew, as page.ts reads it after the backend executed it. */
export interface CensusInput {
  /** The commands, an opcode and three ints each, `commandCount` of them, and their floats. */
  ops: Int32Array;
  commandCount: number;
  params: Float32Array;
  /** The scene list's columns. */
  kind: Uint8Array;
  geometry: Int32Array;
  row: Int32Array;
  texture: Int32Array;
  sampler: Uint8Array;
  /** What draws each entry, FORM_*, with FORM_SMALL and FORM_FRESH. */
  form: Uint8Array;
  /** Each geometry's box by its id, four floats: least x and y, greatest x and y (Geometries.box). */
  boxes: Float32Array;
  /** The rows, ROW_FLOATS each (Rows.data). */
  rows: Float32Array;
  /** Target pixels a unit of the rows. */
  scale: number;
  /** Whether WEBGL_multi_draw drew the runs. */
  multi: boolean;
  /** The runs Draws.prepare gathered, SUB_RUN_INTS each, `subRunCount` of them. */
  subRuns: Int32Array;
  subRunCount: number;
  /** The LAYER_PUSH commands whose one fill was drawn straight onto what is below (blendDirect). */
  direct: ReadonlySet<number>;
  /** Whether the stage is opaque throughout (Commands.opaqueStage), and the target's size. */
  opaque?: boolean;
  width?: number;
  height?: number;
}

/** Blend layers' content from the frame before: positions in target pixels by content. */
export type BlendMemory = Map<string, number[]>;

/** A frame's counts: a flat record, keyed by what is counted (see formatCensus). */
export type Counts = Record<string, number>;

/** Run lengths' buckets: powers of two, the last up to RUN_MOST. */
const LENGTHS = ["1", "2-3", "4-7", "8-15", "16-31", "32-63", "64-127", "128-256"];

function lengthBucket(n: number): string {
  return LENGTHS[Math.min(LENGTHS.length - 1, Math.floor(Math.log2(Math.max(1, n))))];
}

/** Draws inside a blend layer, bucketed. */
const INSIDE = ["0", "1", "2-4", "5-16", "17+"];

function insideBucket(n: number): string {
  return n === 0 ? "0" : n === 1 ? "1" : n <= 4 ? "2-4" : n <= 16 ? "5-16" : "17+";
}

function add(counts: Counts, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

/** A layer open as analyseFrame walks the commands. */
interface Open {
  filtered: boolean;
  /**
   * Whether a filter ran on something in it this frame: a held output, or a filtered layer drawn
   * anew, whose pixels its content then holds, though its draws may be the frame before's.
   */
  refiltered: boolean;
  direct: boolean;
  area: number;
  draws: number;
  parts: string[];
  /** Where its first draw is placed, in target pixels; NaN before one. */
  x: number;
  y: number;
}

/**
 * The census of a frame: its counts, and its blend layers' content for the next frame's to be
 * compared with (`previous`, this frame's before, or null for the first).
 */
export function analyseFrame(
  input: CensusInput,
  previous: BlendMemory | null,
): { counts: Counts; memory: BlendMemory } {
  const counts: Counts = {};
  const labels = commandLabels(input, counts);
  const memory = blendLayers(input, previous, counts);
  fillRuns(input, labels, counts);
  backdropCopies(input, false, counts);
  backdropCopies(input, true, counts);
  return { counts, memory };
}

/**
 * Each command as what it is when it ends a fill run before it, and the layers and composites
 * counted: filter layers drawn and kept, kept and held outputs composited, alpha masks.
 */
function commandLabels(input: CensusInput, counts: Counts): string[] {
  const ops = input.ops;
  const labels: string[] = [];
  const open: boolean[] = [];
  for (let k = 0; k < input.commandCount; k++) {
    const at = k * 4;
    switch (ops[at]) {
      case RUN:
        labels.push("blend mode change");
        break;
      case STENCIL_PUSH:
        labels.push("mask begins");
        break;
      case STENCIL_POP:
        labels.push("mask ends");
        break;
      case LAYER_PUSH: {
        const filtered = ops[at + 2] === 1;
        open.push(filtered);
        labels.push(
          input.direct.has(k)
            ? "blend drawn direct"
            : filtered
              ? "filter layer begins"
              : "blend layer begins",
        );
        break;
      }
      case FILTER:
        if (open.length > 0) {
          open[open.length - 1] = true;
        }

        labels.push("filter layer ends");
        break;
      case LAYER_POP: {
        const filtered = open.pop() ?? false;
        if (ops[at + 1] === ALPHA_MASK) {
          add(counts, "layers.alphaMask");
          labels.push("alpha mask ends");
        } else if (filtered) {
          add(counts, "filter.layers");
          if (ops[at + 3] >= 0) {
            add(counts, "filter.kept");
          }

          labels.push("filter layer ends");
        } else {
          labels.push("blend layer ends");
        }

        break;
      }
      case COMPOSITE:
        add(counts, "filter.composites");
        labels.push("kept output composite");
        break;
      case HELD:
        add(counts, "filter.held");
        labels.push("held output composite");
        break;
      case HOLD_PUSH:
        labels.push("held layer begins");
        break;
      case HOLD_POP:
        labels.push("held layer ends");
        break;
      case CLEAR:
        labels.push("clear");
        break;
      default:
        labels.push("other");
    }
  }

  return labels;
}

/** The DRAW entries `first` up to `end` of the frame. */
function* drawsIn(input: CensusInput, first: number, end: number): Generator<number> {
  for (let i = first; i < end; i++) {
    if (input.kind[i] === DRAW) {
      yield i;
    }
  }
}

/**
 * The blend layers: drawn direct (blendDirect) or as layers, by the draws inside and area; and of
 * those drawn as layers, how many hold what a layer held the frame before, the same draws of the
 * same geometries, textures, linear transforms and colours, placed alike within it, wherever it
 * is: still, moved by whole target pixels, or by fractions of one. A kept content (renderer-plan.md,
 * item 3) would save the drawing of the first two.
 */
function blendLayers(
  input: CensusInput,
  previous: BlendMemory | null,
  counts: Counts,
): BlendMemory {
  const { ops, params, rows, scale } = input;
  const memory: BlendMemory = new Map();
  const unmatched = previous ? new Map([...previous].map(([k, v]) => [k, [...v]])) : null;
  const stack: Open[] = [];
  const note = (part: string) => {
    for (const layer of stack) {
      layer.parts.push(part);
    }
  };
  // Something placed at x, y in target pixels, noted where it lies from each layer's first.
  const placed = (x: number, y: number, part: string) => {
    for (const layer of stack) {
      if (Number.isNaN(layer.x)) {
        layer.x = x;
        layer.y = y;
      }

      layer.parts.push(`${part}@${(x - layer.x).toFixed(3)},${(y - layer.y).toFixed(3)}`);
    }
  };
  const rowOf = (row: number) =>
    row < 0
      ? "-"
      : `${Array.from(rows.subarray(row * ROW_FLOATS, row * ROW_FLOATS + 4)).join(",")}:${Array.from(rows.subarray(row * ROW_FLOATS + 8, (row + 1) * ROW_FLOATS)).join(",")}`;

  for (let k = 0; k < input.commandCount; k++) {
    const at = k * 4;
    switch (ops[at]) {
      case RUN:
      case STENCIL_PUSH:
        for (const i of drawsIn(input, ops[at + 1], ops[at + 1] + ops[at + 2])) {
          const r = input.row[i] * ROW_FLOATS;
          for (const layer of stack) {
            layer.draws++;
          }

          placed(
            rows[r + 4] * scale,
            rows[r + 5] * scale,
            `${ops[at] === RUN ? "d" : "m"}${input.geometry[i]}:${input.texture[i]}:${input.sampler[i]}:${rowOf(input.row[i])}`,
          );
        }

        break;
      case STENCIL_POP:
        note("p");
        break;
      case LAYER_PUSH: {
        const from = ops[at + 1];
        note(`L${params[from + 2]}x${params[from + 3]}`);
        stack.push({
          filtered: ops[at + 2] === 1,
          refiltered: false,
          direct: input.direct.has(k),
          area: params[from + 2] * params[from + 3],
          draws: 0,
          parts: [`${params[from + 2]}x${params[from + 3]}`],
          x: Number.NaN,
          y: Number.NaN,
        });
        break;
      }
      case FILTER:
        note("F");
        for (let n = 0; n < stack.length - 1; n++) {
          stack[n].refiltered = true;
        }

        if (stack.length > 0) {
          stack[stack.length - 1].filtered = true;
        }

        break;
      case COMPOSITE: {
        // A kept output, the same pixels as the frames before, wherever and however coloured.
        const from = ops[at + 1];
        placed(
          params[from],
          params[from + 1],
          `K${params[from + 4]}:${params[from + 2]}x${params[from + 3]}:${ops[at + 2]}:${rowOf(ops[at + 3])}`,
        );
        break;
      }
      case HELD:
        note("H");
        for (const layer of stack) {
          layer.refiltered = true;
        }

        break;
      case LAYER_POP: {
        const layer = stack.pop();
        const mode = ops[at + 1];
        note(`P${mode}`);
        if (!layer || layer.filtered || mode === ALPHA_MASK) {
          break;
        }

        add(counts, `blend.mode.${BLEND_NAMES[mode] ?? `kernel ${mode}`}`);
        if (layer.direct) {
          add(counts, "blend.direct");
          break;
        }

        add(counts, "blend.layers");
        add(counts, "blend.layers.draws", layer.draws);
        add(counts, "blend.layers.area", layer.area);
        add(counts, `blend.inside.${insideBucket(layer.draws)}`);
        if (layer.refiltered) {
          add(counts, "blend.refiltered");
          break;
        }

        const content = layer.parts.join("|");
        const x = Number.isNaN(layer.x) ? 0 : layer.x;
        const y = Number.isNaN(layer.y) ? 0 : layer.y;
        const kept = memory.get(content);
        if (kept) {
          kept.push(x, y);
        } else {
          memory.set(content, [x, y]);
        }

        const before = unmatched?.get(content);
        if (!before || before.length === 0) {
          break;
        }

        // The one it stands still on, else one it moved by whole pixels from, else any.
        let found = -1;
        let how = "moved";
        for (let n = 0; n < before.length; n += 2) {
          const dx = x - before[n];
          const dy = y - before[n + 1];
          if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) {
            found = n;
            how = "still";
            break;
          }

          if (
            how !== "whole" &&
            Math.abs(dx - Math.round(dx)) < 1e-3 &&
            Math.abs(dy - Math.round(dy)) < 1e-3
          ) {
            found = n;
            how = "whole";
          }
        }

        before.splice(found < 0 ? 0 : found, 2);
        add(counts, `blend.unchanged.${how}`);
        add(counts, "blend.unchanged.draws", layer.draws);
        break;
      }
    }
  }

  return memory;
}

/**
 * The fill runs: their lengths, which were merged into one draw, what ended each, and the repeats
 * among the fills of those not merged, which instancing (renderer-plan.md, item 1) would draw as
 * one: a fill of the geometry, texture and sampling of the fill just before it (adjacent), or of
 * one at most WINDOW before it in its run with no draw between them overlapping it (commuting);
 * and, as a bound past either, of any fill not merged earlier in the frame.
 */
function fillRuns(input: CensusInput, labels: string[], counts: Counts): void {
  const { ops, subRuns, form } = input;
  const seen = new Set<number>();
  const gathered: Gathered[] = [];
  for (let s = 0; s < input.subRunCount; s++) {
    const at = s * SUB_RUN_INTS;
    const command = subRuns[at];
    const first = subRuns[at + 1];
    const last = subRuns[at + 2];
    const draws = subRuns[at + 3];
    const merged = subRuns[at + 4] === 1;
    if (subRuns[at + 5] === 1) {
      add(counts, "masks.runs");
      add(counts, "masks.draws", draws);
      // Without WEBGL_multi_draw a mask's fills are merged too.
      if (merged) {
        add(counts, "masks.merged");
        add(counts, "masks.merged.draws", draws);
      }

      continue;
    }

    // The run of a blend drawn direct is drawn by the blend program, not as a run.
    if (draws === 0 || (command > 0 && input.direct.has(command - 1))) {
      continue;
    }

    const bucket = lengthBucket(draws);
    add(counts, "runs");
    add(counts, "runs.draws", draws);
    add(counts, `runs.length.${bucket}`);
    add(counts, `runs.lengthDraws.${bucket}`, draws);
    if (merged) {
      add(counts, "runs.merged");
      add(counts, "runs.merged.draws", draws);
    } else if (draws < MERGED_LEAST_MULTI) {
      add(counts, "runs.short.draws", draws);
    } else {
      add(counts, "runs.long.draws", draws);
    }

    const end = ops[command * 4 + 1] + ops[command * 4 + 2];
    let next = -1;
    for (let j = last + 1; j < end; j++) {
      if (input.kind[j] === DRAW && (form[j] & FORM_KIND) !== FORM_NONE) {
        next = j;
        break;
      }
    }

    add(
      counts,
      `runs.end.${next >= 0 ? splitBy(input, first, next, draws) : (labels[command + 1] ?? "frame end")}`,
    );
    if (!merged) {
      repeats(input, first, last, seen, counts);
    }

    let settled = true;
    let atStart = true;
    for (const i of drawsIn(input, ops[command * 4 + 1], last + 1)) {
      const f = form[i];
      if ((f & FORM_KIND) === FORM_NONE) {
        continue;
      }

      if (i < first) {
        atStart = false;
      } else if (!(f & FORM_SMALL) || f & FORM_FRESH) {
        settled = false;
      }
    }

    gathered.push({ command, draws, atStart, atEnd: next < 0, settled });
  }

  joinedRuns(input, gathered, counts);
}

/** A run fillRuns counted, for joinedRuns. */
interface Gathered {
  command: number;
  draws: number;
  /** Whether it begins its command, and ends it. */
  atStart: boolean;
  atEnd: boolean;
  /** Whether its geometries are all small and none added this frame, as merging asks. */
  settled: boolean;
}

/**
 * A projection of drawing kept and held outputs composited in normal or layer mode as quads in
 * the runs around them (renderer-plan.md, item 2): the runs a composite alone came between
 * joined, each composite a quad of a stable geometry, cut at RUN_MOST; how many there would be,
 * the fills and quads in those that would then merge (MERGED_LEAST_MULTI or more, all settled),
 * and the fills' sub-draws, a merged run one. The texture slots the outputs take are not
 * counted, so it is the most the item could take. With WEBGL_multi_draw alone: without it,
 * merging waits for a run drawn alike the frame before, which one frame does not say.
 */
function joinedRuns(input: CensusInput, gathered: readonly Gathered[], counts: Counts): void {
  if (!input.multi) {
    return;
  }

  const ops = input.ops;
  const between = (from: number, to: number) => {
    let quads = 0;
    for (let k = from + 1; k < to; k++) {
      const op = ops[k * 4];
      const mode = ops[k * 4 + 2];
      if ((op !== COMPOSITE && op !== HELD) || (mode !== NORMAL && mode !== LAYER)) {
        return -1;
      }

      quads++;
    }

    return quads > 0 && ops[from * 4 + 3] === ops[to * 4 + 3] ? quads : -1;
  };
  const flush = (draws: number, settled: boolean) => {
    for (let left = draws; left > 0; left -= RUN_MOST) {
      const chunk = Math.min(RUN_MOST, left);
      add(counts, "joined.runs");
      if (settled && chunk >= MERGED_LEAST_MULTI) {
        add(counts, "joined.mergeable", chunk);
        add(counts, "joined.subDraws");
      } else {
        add(counts, "joined.subDraws", chunk);
      }
    }
  };

  let draws = 0;
  let settled = true;
  for (let g = 0; g < gathered.length; g++) {
    const run = gathered[g];
    const quads = g > 0 ? between(gathered[g - 1].command, run.command) : -1;
    if (g > 0 && gathered[g - 1].atEnd && run.atStart && quads > 0) {
      add(counts, "joined.quads", quads);
      draws += quads + run.draws;
      settled &&= run.settled;
      continue;
    }

    flush(draws, settled);
    draws = run.draws;
    settled = run.settled;
  }

  flush(draws, settled);
}

/** What ended a run from `first` before entry `next` of its command, a draw it did not take. */
function splitBy(input: CensusInput, first: number, next: number, draws: number): string {
  const form = input.form;
  switch (form[next] & FORM_KIND) {
    case FORM_GLYPHS:
      return "glyphs";
    case FORM_MESH:
      return "mesh";
    case FORM_SHADED:
      return "shader fill";
    case FORM_STAGE:
      return "stage-sampling fill";
  }

  if (draws >= RUN_MOST) {
    return `${RUN_MOST} draws`;
  }

  // Without WEBGL_multi_draw a run is of geometries too large to merge, fresh or stable alone.
  const of = (f: number) => (!(f & FORM_SMALL) ? 0 : f & FORM_FRESH ? 1 : 2);
  if (!input.multi && of(form[next]) !== of(form[first])) {
    return "fresh or stable split";
  }

  return "texture slots";
}

/** The repeats among the fills of a run not merged, entries `first` to `last` (fillRuns). */
function repeats(
  input: CensusInput,
  first: number,
  last: number,
  seen: Set<number>,
  counts: Counts,
): void {
  const keys: number[] = [];
  const boxes: number[] = [];
  const large: boolean[] = [];
  for (const i of drawsIn(input, first, last + 1)) {
    if ((input.form[i] & FORM_KIND) !== FORM_FILL) {
      continue;
    }

    keys.push(keyOf(input, i));
    placeBox(input, i, boxes);
    large.push(!(input.form[i] & FORM_SMALL));
  }

  for (let j = 0; j < keys.length; j++) {
    add(counts, "repeat.draws");
    if (large[j]) {
      add(counts, "repeat.large");
    }

    if (seen.has(keys[j])) {
      add(counts, "repeat.frame");
    }

    seen.add(keys[j]);
    let commutes = false;
    for (let p = j - 1; p >= Math.max(0, j - WINDOW); p--) {
      if (keys[p] === keys[j]) {
        commutes = true;
        break;
      }

      if (overlap(boxes, p, j)) {
        break;
      }
    }

    if (j > 0 && keys[j - 1] === keys[j]) {
      add(counts, "repeat.adjacent");
      if (large[j]) {
        add(counts, "repeat.large.adjacent");
      }
    }

    if (commutes) {
      add(counts, "repeat.commuting");
      if (large[j]) {
        add(counts, "repeat.large.commuting");
      }
    }
  }
}

/** An entry's geometry, texture and sampling as one number: what an instanced draw shares. */
function keyOf(input: CensusInput, i: number): number {
  const sampling = input.sampler[i] & (SMOOTH | REPEAT | MIRROR | SNAP);
  return (input.geometry[i] * 0x100000 + (input.texture[i] + 1)) * 64 + sampling;
}

/** Entry `i`'s geometry's box placed by its row, in target pixels, pushed onto `out`. */
function placeBox(input: CensusInput, i: number, out: number[]): void {
  const g = input.geometry[i] * 4;
  const r = input.row[i] * ROW_FLOATS;
  const { boxes, rows, scale } = input;
  const [a, b, c, d, tx, ty] = rows.subarray(r, r + 6);
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const [x, y] of [
    [boxes[g], boxes[g + 1]],
    [boxes[g + 2], boxes[g + 1]],
    [boxes[g], boxes[g + 3]],
    [boxes[g + 2], boxes[g + 3]],
  ]) {
    const px = (a * x + c * y + tx) * scale;
    const py = (b * x + d * y + ty) * scale;
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }

  out.push(x0, y0, x1, y1);
}

/** Whether boxes `p` and `j` meet, or come within MARGIN of each other. */
function overlap(boxes: number[], p: number, j: number): boolean {
  const a = p * 4;
  const b = j * 4;
  return (
    boxes[a] < boxes[b + 2] + MARGIN &&
    boxes[b] < boxes[a + 2] + MARGIN &&
    boxes[a + 1] < boxes[b + 3] + MARGIN &&
    boxes[b + 1] < boxes[a + 3] + MARGIN
  );
}

/** Whether blend mode `mode` reads what is below onto a target `opaque` or not (webgl/composite.ts). */
function readsBelow(mode: number, opaque: boolean): boolean {
  return !(
    mode === NORMAL ||
    mode === ALPHA_MASK ||
    mode === LAYER ||
    mode === ADD ||
    mode === SCREEN ||
    (mode === MULTIPLY && opaque)
  );
}

/** A target as backdropCopies walks the commands: where it lies, and the copy open on it. */
interface CopyTarget {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  opaque: boolean;
  /** The rectangles one copy would take for the blends that share it, four numbers each; null for none open. */
  copied: number[] | null;
  /** What was drawn into the target since that copy, four numbers each. */
  drawn: number[];
}

/** Whether rectangle `a` of `from` meets rectangle `x0, y0, x1, y1`. */
function meets(from: number[], a: number, x0: number, y0: number, x1: number, y1: number): boolean {
  return from[a] < x1 && x0 < from[a + 2] && from[a + 1] < y1 && y0 < from[a + 3];
}

/**
 * The blends that read what is below, drawn direct or composited, each of which would copy it
 * unshared (Compositor.copyBoxes); and how many could share the copy an earlier one made on their
 * target, as one copy of more than one rectangle (renderer-plan.md, item 3): those whose
 * rectangles meet nothing drawn into the target since that copy. Counted twice:
 * `loose`, past draws, masks and composites in between that do not meet them, the copy given up
 * where another target's copy takes its place; and not, between blends drawn direct alone.
 */
function backdropCopies(input: CensusInput, loose: boolean, counts: Counts): void {
  const { ops, params } = input;
  const key = loose ? "share.loose" : "share.strict";
  const stack: CopyTarget[] = [
    {
      x0: 0,
      y0: 0,
      x1: input.width ?? Number.POSITIVE_INFINITY,
      y1: input.height ?? Number.POSITIVE_INFINITY,
      opaque: input.opaque ?? false,
      copied: null,
      drawn: [],
    },
  ];
  let owner: CopyTarget | null = null;
  const close = (target: CopyTarget) => {
    const copied = target.copied;
    if (copied && copied.length > 4) {
      let parts = 0;
      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (let a = 0; a < copied.length; a += 4) {
        parts += (copied[a + 2] - copied[a]) * (copied[a + 3] - copied[a + 1]);
        x0 = Math.min(x0, copied[a]);
        y0 = Math.min(y0, copied[a + 1]);
        x1 = Math.max(x1, copied[a + 2]);
        y1 = Math.max(y1, copied[a + 3]);
      }

      add(counts, `${key}.groups`);
      add(counts, `${key}.parts`, parts);
      add(counts, `${key}.union`, (x1 - x0) * (y1 - y0));
    }

    target.copied = null;
    target.drawn.length = 0;
  };
  // Something drawn into the top target over a rectangle, or over all of it.
  const drawn = (x0: number, y0: number, x1: number, y1: number) => {
    const top = stack[stack.length - 1];
    if (top.copied) {
      top.drawn.push(x0, y0, x1, y1);
    }
  };
  // A blend over rectangle `left, top, right, bottom`, cut to the target's, as cover cuts it.
  const blend = (
    left: number,
    up: number,
    right: number,
    bottom: number,
    mode: number,
    direct: boolean,
  ) => {
    const top = stack[stack.length - 1];
    const x0 = Math.max(top.x0, left);
    const y0 = Math.max(top.y0, up);
    const x1 = Math.min(top.x1, right);
    const y1 = Math.min(top.y1, bottom);
    if (x1 <= x0 || y1 <= y0) {
      return;
    }

    if (readsBelow(mode, top.opaque)) {
      if (!loose) {
        add(counts, "copies.computed");
        add(counts, direct ? "copies.direct" : "copies.composite");
      }

      let shares = top.copied !== null && owner === top && (loose || direct);
      for (let a = 0; shares && a < top.drawn.length; a += 4) {
        shares = !meets(top.drawn, a, x0, y0, x1, y1);
      }

      if (shares) {
        add(counts, `${key}.${direct ? "direct" : "composite"}`);
        top.copied?.push(x0, y0, x1, y1);
      } else {
        if (owner) {
          close(owner);
        }

        if (loose || direct) {
          top.copied = [x0, y0, x1, y1];
          owner = top;
        }
      }
    }

    drawn(x0, y0, x1, y1);
  };
  const box: number[] = [];

  for (let k = 0; k < input.commandCount; k++) {
    const at = k * 4;
    const top = stack[stack.length - 1];
    switch (ops[at]) {
      case RUN:
        if (!loose) {
          close(top);
          break;
        }

        for (const i of drawsIn(input, ops[at + 1], ops[at + 1] + ops[at + 2])) {
          box.length = 0;
          placeBox(input, i, box);
          drawn(box[0] - MARGIN, box[1] - MARGIN, box[2] + MARGIN, box[3] + MARGIN);
        }

        break;
      case STENCIL_PUSH:
      case STENCIL_POP:
        // A mask draws into the stencil alone.
        if (!loose) {
          close(top);
        }

        break;
      case HOLD_PUSH: {
        // Drawn ahead of the stage, its copies apart from the stage's.
        if (!loose) {
          close(top);
        }

        let depth = 0;
        for (; ops[k * 4] !== HOLD_POP; k++) {
          const op = ops[k * 4];
          if (op === LAYER_PUSH) {
            depth++;
          } else if (
            op === LAYER_POP &&
            depth-- > 0 &&
            !loose &&
            readsBelow(ops[k * 4 + 1], false)
          ) {
            add(counts, "copies.computed");
            add(counts, "copies.composite");
          }
        }

        break;
      }
      case COMPOSITE:
        if (!loose) {
          close(top);
        }

        blend(
          params[ops[at + 1]],
          params[ops[at + 1] + 1],
          params[ops[at + 1]] + params[ops[at + 1] + 2],
          params[ops[at + 1] + 1] + params[ops[at + 1] + 3],
          ops[at + 2],
          false,
        );
        break;
      case LAYER_PUSH: {
        const from = ops[at + 1];
        if (input.direct.has(k)) {
          // Its run and its pop with it, the pop's mode the blend's.
          blend(
            params[from],
            params[from + 1],
            params[from] + params[from + 2],
            params[from + 1] + params[from + 3],
            ops[at + 9],
            true,
          );
          k += 2;
          break;
        }

        if (!loose) {
          close(top);
        }

        stack.push({
          x0: params[from],
          y0: params[from + 1],
          x1: params[from] + params[from + 2],
          y1: params[from + 1] + params[from + 3],
          opaque: false,
          copied: null,
          drawn: [],
        });
        break;
      }
      case LAYER_POP: {
        const layer = stack.pop() as CopyTarget;
        close(layer);
        if (!loose) {
          close(stack[stack.length - 1]);
        }

        blend(layer.x0, layer.y0, layer.x1, layer.y1, ops[at + 1], false);
        break;
      }
      case FILTER:
        break;
      default:
        // A clear, a held output composited over a rectangle not read here.
        close(top);
    }
  }

  for (const target of stack) {
    close(target);
  }
}

/** The display objects' flags (player/src/display/displayobject.ts). */
const TRANSFORM = 1;
const CHILDREN = 2;
const CONTENT = 4;
const PIXELS = 8;

/** What dirtyMarks reads of a display object. */
export interface Dirtied {
  dirty: number;
  descendantsDirty?: boolean;
  children?: readonly Dirtied[];
}

/** A mark's bit (dirtyMarks), past the flags: a walk of what changed would visit it. */
const NEEDED = 1 << 8;

/**
 * Every object under `root`, through its children, as it stands before the walk clears it: its
 * flags, and NEEDED where a walk that visited only what changed would visit it, as it changed, or
 * has a changed descendant, or is in the subtree of one whose transform, colour or content changed,
 * as its rows follow. walkCensus counts them against the objects the walk did visit.
 */
export function dirtyMarks(root: Dirtied): Map<Dirtied, number> {
  const marks = new Map<Dirtied, number>();
  const visit = (o: Dirtied, moved: boolean) => {
    const dirty = o.dirty;
    marks.set(o, dirty | (moved || dirty !== 0 || o.descendantsDirty ? NEEDED : 0));
    const below = moved || (dirty & (TRANSFORM | CONTENT)) !== 0;
    for (const child of o.children ?? []) {
      visit(child, below);
    }
  };
  visit(root, false);
  return marks;
}

/** What the walk did in a render (page.ts counts it): its calls, and the objects it drew. */
export interface Walked {
  /** RenderView.walk's calls that drew, and the distinct objects they were of. */
  calls: number;
  objects: ReadonlySet<Dirtied>;
  /** Its calls on hidden objects, which return at once (syncHidden passes their subtrees over). */
  hidden: number;
  /** The mask walker's calls (Masks.walkMask), a mask's objects, which RenderView.walk leaves. */
  masks: number;
}

/**
 * The walk against what changed: the objects it visited (once each; an alpha mask or a 3D object's
 * content may be walked twice, `walk.again`), and of those how many changed, by what, and how
 * many a walk of what changed would visit (`walk.needed`, never more than were visited); apart,
 * the objects under `marks` the walk did not visit, hidden, masks or the content of a kept
 * output, and how many of those changed; `walk.rowsOnly` 1 where nothing visited changed but
 * transforms, colours and pixels.
 */
export function walkCensus(marks: ReadonlyMap<Dirtied, number>, walked: Walked): Counts {
  const counts: Counts = {
    "walk.calls": walked.calls,
    "walk.visited": walked.objects.size,
    "walk.again": walked.calls - walked.objects.size,
    "walk.hidden": walked.hidden,
    "walk.masks": walked.masks,
    "walk.dirty": 0,
    "walk.needed": 0,
    "walk.unwalked": 0,
    "walk.unwalkedDirty": 0,
  };
  let structural = false;
  for (const [o, mark] of marks) {
    const dirty = mark & 0xff;
    if (!walked.objects.has(o)) {
      add(counts, "walk.unwalked");
      if (dirty !== 0) {
        add(counts, "walk.unwalkedDirty");
      }

      continue;
    }

    if (mark & NEEDED) {
      add(counts, "walk.needed");
    }

    if (dirty === 0) {
      continue;
    }

    add(counts, "walk.dirty");
    if (dirty & (CHILDREN | CONTENT)) {
      structural = true;
      add(counts, dirty & CONTENT ? "walk.content" : "walk.children");
    } else {
      add(
        counts,
        dirty & TRANSFORM ? "walk.transform" : dirty & PIXELS ? "walk.pixels" : "walk.other",
      );
    }
  }

  counts["walk.rowsOnly"] = structural ? 0 : 1;
  return counts;
}

/**
 * The records of frames `first` on, by the frame each was tagged with (page.ts, Census.at), the tag
 * left out; a render left out (a frame whose runs were not prepared) shifts none of the others.
 * Throws where none is left: a census that counted nothing must not read as one of nothing.
 */
export function framesFrom(records: readonly Counts[], first: number): Counts[] {
  const out = records.filter((r) => r.frame >= first).map(({ frame: _, ...counts }) => counts);
  if (out.length === 0) {
    throw new Error(
      `the census counted no frame from frame ${first} on, of ${records.length} records`,
    );
  }

  return out;
}

/** Each key's mean over `frames`, and how many frames there were (`frames`). */
export function summarise(frames: readonly Counts[]): Counts {
  const sums: Counts = {};
  for (const frame of frames) {
    for (const [key, value] of Object.entries(frame)) {
      add(sums, key, value);
    }
  }

  const out: Counts = { frames: frames.length };
  for (const [key, sum] of Object.entries(sums)) {
    out[key] = sum / Math.max(1, frames.length);
  }

  return out;
}

/** The sub-draws by how they were drawn (page.ts, path keys), in the report's order. */
const PATHS: [string, string][] = [
  ["path.merged", "merged"],
  ["path.multi", "multi-draw"],
  ["path.single", "a call a fill"],
  ["path.blended", "blend program"],
  ["path.mesh", "mesh"],
  ["path.glyphs", "glyphs"],
  ["path.stage", "stage-sampling fills"],
  ["path.other", "composites, filter passes, shader fills, the stage"],
];

/** A summary (summarise) as the lines bench.ts prints. */
export function formatCensus(s: Counts): string[] {
  const v = (key: string) => s[key] ?? 0;
  const n = (x: number) =>
    x >= 100 ? Math.round(x).toLocaleString("en") : String(Math.round(x * 10) / 10);
  const pct = (x: number, of: number) => (of > 0 ? `${Math.round((x / of) * 100)}%` : "-");
  const keyed = (prefix: string) =>
    Object.keys(s)
      .filter((k) => k.startsWith(prefix))
      .map((k) => [k.slice(prefix.length), s[k]] as [string, number])
      .sort((a, b) => b[1] - a[1]);
  const subDraws = PATHS.reduce((sum, [key]) => sum + v(key), 0);
  const runs = v("runs");
  const draws = v("runs.draws");
  const notMerged = v("repeat.draws");
  const lines = [`census, a frame's mean over ${v("frames")} frames:`];
  lines.push(
    `  sub-draws    ${n(subDraws)}: ${PATHS.filter(([key]) => v(key) > 0)
      .map(([key, name]) => `${name} ${n(v(key))}`)
      .join(", ")}`,
  );
  lines.push(
    `  fill runs    ${n(runs)} of ${n(draws)} fills, ${n(draws / Math.max(1, runs))} a run; merged ${n(v("runs.merged"))} (${n(v("runs.merged.draws"))} fills); not merged, ${n(v("runs.short.draws"))} fills in runs under ${MERGED_LEAST_MULTI} and ${n(v("runs.long.draws"))} in longer`,
  );
  lines.push(
    `    lengths    ${LENGTHS.filter((b) => v(`runs.length.${b}`) > 0)
      .map(
        (b) =>
          `${b}: ${pct(v(`runs.length.${b}`), runs)} of runs, ${pct(v(`runs.lengthDraws.${b}`), draws)} of fills`,
      )
      .join("; ")}`,
  );
  lines.push(
    `    ended by   ${keyed("runs.end.")
      .map(([why, x]) => `${why} ${pct(x, runs)}`)
      .join(", ")}`,
  );
  if (v("joined.runs") > 0) {
    // The fills' sub-draws now, masks' left out as the projection leaves them.
    const maskSubDraws = v("masks.draws") - v("masks.merged.draws") + v("masks.merged");
    const now = v("path.merged") + v("path.multi") + v("path.single") - maskSubDraws;
    const composites = v("filter.composites") + v("filter.held");
    lines.push(
      `    if joined  across normal composites, as item 2 of renderer-plan.md would draw them: ${n(v("joined.runs"))} runs, ${n(v("joined.quads"))} composites among their fills as quads; fills and quads in runs that would merge ${n(v("joined.mergeable"))}, sub-draws of fills and quads ${n(v("joined.subDraws"))} (now ${n(now)} of fills, masks' left out, and ${n(v("joined.quads"))} of the ${n(composites)} composites); ${n(composites - v("joined.quads"))} composites stay as they are`,
    );
    lines.push(
      "               an upper bound: it assumes the merged stream has room, and leaves out the texture slots, of which each kept output would take one of a run's 8",
    );
  }

  if (v("masks.runs") > 0) {
    lines.push(
      `    masks      ${n(v("masks.runs"))} runs of ${n(v("masks.draws"))} fills, ${n(v("masks.merged.draws"))} of them merged`,
    );
  }

  lines.push(
    `  repeats      of ${n(notMerged)} fills not merged: adjacent ${n(v("repeat.adjacent"))} (${pct(v("repeat.adjacent"), notMerged)}), commuting within ${WINDOW} ${n(v("repeat.commuting"))} (${pct(v("repeat.commuting"), notMerged)}), anywhere in the frame ${n(v("repeat.frame"))} (${pct(v("repeat.frame"), notMerged)}); of all sub-draws, commuting ${pct(v("repeat.commuting"), subDraws)}`,
  );
  lines.push(
    `    too large to merge ${n(v("repeat.large"))}: adjacent ${n(v("repeat.large.adjacent"))}, commuting ${n(v("repeat.large.commuting"))}`,
  );
  const layers = v("blend.layers");
  const unchanged = v("blend.unchanged.still") + v("blend.unchanged.whole");
  lines.push(
    `  blends       ${n(v("blend.direct") + layers)} (${keyed("blend.mode.")
      .map(([mode, x]) => `${mode} ${n(x)}`)
      .join(", ")}): drawn direct ${n(v("blend.direct"))}, as layers ${n(layers)}`,
  );
  lines.push(
    `    layers     ${n(v("blend.layers.draws"))} fills inside (${INSIDE.map((b) => `${b}: ${n(v(`blend.inside.${b}`))}`).join(", ")}), ${n(v("blend.layers.area") / 1000)} k pixels`,
  );
  const union = (variant: string) =>
    v(`${variant}.groups`) > 0
      ? `, ${n(v(`${variant}.groups`))} copies of more than one, their bounding boxes ${n(v(`${variant}.union`) / Math.max(1, v(`${variant}.parts`)))} times their rectangles' area`
      : "";
  lines.push(
    `    copies     made ${n(v("copies"))} of ${n(v("copies.boxes"))} boxes, for ${n(v("copies.computed"))} blends that read what is below (direct ${n(v("copies.direct"))}, composited ${n(v("copies.composite"))}); of those, could share an earlier one's copy: after blends drawn direct alone ${n(v("share.strict.direct"))}${union("share.strict")}; past draws, masks and composites that do not meet them ${n(v("share.loose.direct") + v("share.loose.composite"))} (${n(v("share.loose.direct"))} direct)${union("share.loose")}`,
  );
  lines.push(
    `    unchanged  ${n(unchanged)} of ${n(layers)} (${pct(unchanged, layers)}) hold the frame before's content still or moved by whole pixels (${n(v("blend.unchanged.still"))} still, ${n(v("blend.unchanged.whole"))} whole), ${n(v("blend.unchanged.moved"))} more moved by fractions; ${n(v("blend.unchanged.draws"))} fills inside them; ${n(v("blend.refiltered"))} hold a filter's output made this frame, and are not compared`,
  );
  lines.push(
    "               a filtered object in a blend mode is one layer, counted with the filter layers, not here",
  );
  lines.push(
    `  filters      layers drawn ${n(v("filter.layers"))} (${n(v("filter.kept"))} kept), kept outputs composited ${n(v("filter.composites"))}, held ${n(v("filter.held"))}; alpha masks ${n(v("layers.alphaMask"))}`,
  );
  const visited = v("walk.visited");
  lines.push(
    `  walk         visited ${n(visited)} objects and again ${n(v("walk.again"))} times (alpha masks, 3D content), passed over ${n(v("walk.hidden"))} hidden roots, and the mask walker ${n(v("walk.masks"))} objects; of those visited, changed ${n(v("walk.dirty"))} (${pct(v("walk.dirty"), visited)}: transform or colour ${n(v("walk.transform"))}, content ${n(v("walk.content"))}, children ${n(v("walk.children"))}, pixels ${n(v("walk.pixels"))}); a walk of what changed would visit ${n(v("walk.needed"))} (${pct(v("walk.needed"), visited)}); rows-only frames ${pct(v("walk.rowsOnly"), 1)}`,
  );
  lines.push(
    `    unwalked   ${n(v("walk.unwalked"))} objects in the tree the walk did not visit (hidden, masks, kept outputs' content), ${n(v("walk.unwalkedDirty"))} of them changed`,
  );
  return lines;
}
