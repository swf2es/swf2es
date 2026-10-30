import {
  CLEAR,
  COMPOSITE,
  type Commands,
  FILTER,
  HELD,
  HOLD_POP,
  HOLD_PUSH,
  LAYER_POP,
  LAYER_PUSH,
  RUN,
  STENCIL_POP,
  STENCIL_PUSH,
} from "./commands.js";
import {
  ALPHA,
  DRAW,
  ERASE,
  KEPT,
  LAYER_BEGIN,
  LAYER_END,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  NO_WHOLE,
  type SceneList,
} from "./scene.js";

/**
 * Plan a frame: clear to `background` (0xAARRGGBB, straight), then a run
 * for each stretch of the list under one blend mode, each mask pushed into
 * the stencil and popped out, and each layer pushed and composited, where
 * their markers say; a layer of no size is left out, all in it. A filtered
 * layer of draws, masks and held layers alone, not kept, is held (findHolds):
 * drawn before the stage, with every other such of its level, after those
 * it holds (HOLD_PUSH), and composited where it stands (HELD). Pure: the
 * same list plans the same commands.
 */
export function plan(scene: SceneList, background: number, out: Commands): void {
  out.reset();
  open.length = 0;
  if (heldAt.length < scene.length) {
    heldAt = new Int32Array(Math.max(scene.length, heldAt.length * 2));
  }

  heldAt.fill(-1, 0, scene.length);
  findHolds(scene);
  // Numbered a level after another, in their order within each (a counting sort by level).
  levelStart.length = mostLevel + 2;
  levelStart.fill(0);
  for (let h = 0; h < heldBegin.length; h++) {
    levelStart[heldLevel[h] + 1]++;
  }

  for (let level = 1; level < levelStart.length; level++) {
    levelStart[level] += levelStart[level - 1];
  }

  heldOrder.length = heldBegin.length;
  for (let h = 0; h < heldBegin.length; h++) {
    heldOrder[levelStart[heldLevel[h]]++] = h;
  }

  for (let n = 0; n < heldOrder.length; n++) {
    heldAt[heldBegin[heldOrder[n]]] = n;
  }

  for (let n = 0; n < heldOrder.length; n++) {
    const h = heldOrder[n];
    const i = heldBegin[h];
    const end = heldEnd[h];
    out.push(HOLD_PUSH, layerParams(out, scene, scene.geometry[i]), n, heldLevel[h]);
    emit(scene, i + 1, end, out, false);
    out.push(HOLD_POP, scene.texture[end], n);
  }

  const alpha = (background >>> 24) / 255;
  out.push(
    CLEAR,
    out.param(
      (((background >> 16) & 0xff) / 255) * alpha,
      (((background >> 8) & 0xff) / 255) * alpha,
      ((background & 0xff) / 255) * alpha,
      alpha,
    ),
  );
  emit(scene, 0, scene.length, out, true);
}

/**
 * The commands for the list's entries from `from` to before `to`: a run for
 * each stretch under one blend mode, outside a mask's own draws, which its
 * markers name for the stencil; masks, layers and kept outputs where their
 * markers are; a held layer's composite where it begins (heldAt). Of the
 * `stage`, not a held layer's content, which clears its own page alone.
 */
function emit(scene: SceneList, from: number, to: number, out: Commands, stage: boolean): void {
  let first = -1;
  let masking = false;
  const close = (end: number) => {
    if (first >= 0 && end > first) {
      out.push(RUN, first, end - first, scene.blend[first]);
    }

    first = -1;
  };

  for (let i = from; i < to; i++) {
    switch (scene.kind[i]) {
      case DRAW:
        if (!masking && first >= 0 && scene.blend[i] !== scene.blend[first]) {
          close(i);
        }

        if (!masking && first < 0) {
          first = i;
        }

        break;
      case MASK_BEGIN:
        close(i);
        masking = true;
        break;
      case MASK_USE:
        masking = false;
        out.push(STENCIL_PUSH, scene.geometry[i], scene.row[i]);
        break;
      case MASK_POP:
        close(i);
        out.push(STENCIL_POP, scene.geometry[i], scene.row[i]);
        break;
      case LAYER_BEGIN: {
        close(i);
        if (heldAt[i] >= 0) {
          const end = layerEnd(scene, i);
          out.push(HELD, heldAt[i], scene.geometry[end], scene.row[end]);
          if (stage) {
            noteClearing(out, scene.geometry[end]);
          }

          i = end;
          break;
        }

        const r = scene.layers;
        const at = scene.geometry[i] * 4;
        if (r[at + 2] <= 0 || r[at + 3] <= 0) {
          // Nothing of it shows: all in it left out, up to its end.
          i = layerEnd(scene, i);
          break;
        }

        open.push(scene.geometry[i]);
        out.push(
          LAYER_PUSH,
          layerParams(out, scene, scene.geometry[i]),
          scene.pads[scene.geometry[i]] >= 0 ? 1 : 0,
        );
        break;
      }
      case LAYER_END:
        close(i);
        if (scene.texture[i] >= 0) {
          out.push(FILTER, scene.texture[i]);
        }

        out.push(LAYER_POP, scene.geometry[i], scene.row[i], scene.keeps[open.pop() as number]);
        noteClearing(out, scene.geometry[i]);
        break;
      case KEPT: {
        close(i);
        const r = scene.layers;
        const at = scene.geometry[i] * 4;
        if (r[at + 2] > 0 && r[at + 3] > 0) {
          out.push(
            COMPOSITE,
            out.param(r[at], r[at + 1], r[at + 2], r[at + 3], scene.texture[i]),
            scene.blend[i],
            scene.row[i],
          );
          noteClearing(out, scene.blend[i]);
        }

        break;
      }
    }
  }

  close(to);
}

/** Each entry's held layer, by number, where a layer it begins is held; else -1. */
let heldAt = new Int32Array(256);

/** The held layers found (findHolds): where each begins and ends, and its level; the deepest level. */
const heldBegin: number[] = [];
const heldEnd: number[] = [];
const heldLevel: number[] = [];
/** Where each level's held layers start in their numbering, and the held layers in it. */
const levelStart: number[] = [];
const heldOrder: number[] = [];
let mostLevel = 0;

/** The layers open as findHolds walks: where each begins, the level its held layers reach, whether it may be held. */
const openBegin: number[] = [];
const openLevel: number[] = [];
const openHoldable: boolean[] = [];

/**
 * The layers held: filtered, not kept for the frames after, of some size,
 * and of draws, masks and held layers alone, with no other layer or kept
 * output in them, whose content no other target takes part in. Each has a
 * level, one past the deepest of those in it, and leaves 0, so that a held
 * layer's are drawn before it. A layer of no size is left out, all in it.
 */
function findHolds(scene: SceneList): void {
  heldBegin.length = 0;
  heldEnd.length = 0;
  heldLevel.length = 0;
  openBegin.length = 0;
  openLevel.length = 0;
  openHoldable.length = 0;
  mostLevel = 0;

  for (let i = 0; i < scene.length; i++) {
    switch (scene.kind[i]) {
      case LAYER_BEGIN: {
        const layer = scene.geometry[i];
        if (scene.layers[layer * 4 + 2] <= 0 || scene.layers[layer * 4 + 3] <= 0) {
          i = layerEnd(scene, i);
          break;
        }

        openBegin.push(i);
        openLevel.push(0);
        openHoldable.push(scene.pads[layer] >= 0 && scene.keeps[layer] < 0);
        break;
      }
      case KEPT:
        if (openHoldable.length > 0) {
          openHoldable[openHoldable.length - 1] = false;
        }

        break;
      case LAYER_END: {
        const begin = openBegin.pop() as number;
        const level = openLevel.pop() as number;
        const held = (openHoldable.pop() as boolean) && scene.texture[i] >= 0;
        if (held) {
          heldBegin.push(begin);
          heldEnd.push(i);
          heldLevel.push(level);
          mostLevel = Math.max(mostLevel, level);
        }

        const top = openBegin.length - 1;
        if (top >= 0) {
          if (held) {
            openLevel[top] = Math.max(openLevel[top], level + 1);
          } else {
            openHoldable[top] = false;
          }
        }

        break;
      }
    }
  }
}

/**
 * Layer `layer`'s params: its rectangle, then where its object lies in it
 * and its size (SceneList.objects), or a width of -1 for none, as a whole
 * layer's ShaderFilters read it.
 */
function layerParams(out: Commands, scene: SceneList, layer: number): number {
  const r = scene.layers;
  const o = scene.objects;
  const at = layer * 4;
  return scene.wholes[layer] === NO_WHOLE
    ? out.param(r[at], r[at + 1], r[at + 2], r[at + 3], 0, 0, -1, -1)
    : out.param(
        r[at],
        r[at + 1],
        r[at + 2],
        r[at + 3],
        o[at] - r[at],
        o[at + 1] - r[at + 1],
        o[at + 2],
        o[at + 3],
      );
}

/** The layers pushed and not yet popped, by number, innermost last. */
const open: number[] = [];

/** A layer composited in `mode` noted where it clears the target itself (Commands.clearsTarget). */
function noteClearing(out: Commands, mode: number): void {
  if (open.length === 0 && (mode === ERASE || mode === ALPHA)) {
    out.clearsTarget = true;
  }
}

/** The LAYER_END that closes the layer begun at entry `begin`. */
function layerEnd(scene: SceneList, begin: number): number {
  let depth = 0;
  for (let i = begin; i < scene.length; i++) {
    switch (scene.kind[i]) {
      case LAYER_BEGIN:
        depth++;
        break;
      case LAYER_END:
        if (--depth === 0) {
          return i;
        }

        break;
    }
  }

  return scene.length;
}
