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
  type SceneList,
} from "./scene.js";

/**
 * Plan a frame: clear to `background` (0xAARRGGBB, straight), then a run
 * for each stretch of the list under one blend mode, each mask pushed into
 * the stencil and popped out, and each layer pushed and composited, where
 * their markers say; a layer of no size is left out, all in it. A filtered
 * layer of draws and masks alone, not kept, is held: drawn before the
 * stage, with every other such (HOLD_PUSH), and composited where it stands
 * (HELD). Pure: the same list plans the same commands.
 */
export function plan(scene: SceneList, background: number, out: Commands): void {
  out.reset();
  open.length = 0;
  if (heldAt.length < scene.length) {
    heldAt = new Int32Array(Math.max(scene.length, heldAt.length * 2));
  }

  let holds = 0;
  for (let i = 0; i < scene.length; i++) {
    heldAt[i] = -1;
    if (scene.kind[i] === LAYER_BEGIN && holdable(scene, i)) {
      heldAt[i] = holds++;
    }
  }

  for (let i = 0; i < scene.length; i++) {
    if (scene.kind[i] === LAYER_BEGIN && heldAt[i] >= 0) {
      const r = scene.layers;
      const at = scene.geometry[i] * 4;
      const end = layerEnd(scene, i);
      out.push(HOLD_PUSH, out.param(r[at], r[at + 1], r[at + 2], r[at + 3]), heldAt[i]);
      emit(scene, i + 1, end, out);
      out.push(HOLD_POP, scene.texture[end], heldAt[i]);
      i = end;
    }
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
  emit(scene, 0, scene.length, out);
}

/**
 * The commands for the list's entries from `from` to before `to`: a run for
 * each stretch under one blend mode, outside a mask's own draws, which its
 * markers name for the stencil; masks, layers and kept outputs where their
 * markers are; a held layer's composite where it begins (heldAt).
 */
function emit(scene: SceneList, from: number, to: number, out: Commands): void {
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
          noteClearing(out, scene.geometry[end]);
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
          out.param(r[at], r[at + 1], r[at + 2], r[at + 3]),
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

/**
 * Whether the layer begun at entry `begin` is held: of some size, filtered,
 * not kept for the frames after, and of draws and masks alone, with no
 * layer or kept output in it, whose content no other target takes part in.
 */
function holdable(scene: SceneList, begin: number): boolean {
  const layer = scene.geometry[begin];
  const at = layer * 4;
  if (
    scene.layers[at + 2] <= 0 ||
    scene.layers[at + 3] <= 0 ||
    scene.pads[layer] < 0 ||
    scene.keeps[layer] >= 0
  ) {
    return false;
  }

  for (let i = begin + 1; i < scene.length; i++) {
    switch (scene.kind[i]) {
      case LAYER_END:
        return scene.texture[i] >= 0;
      case LAYER_BEGIN:
      case KEPT:
        return false;
    }
  }

  return false;
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
