import {
  CLEAR,
  COMPOSITE,
  type Commands,
  FILTER,
  LAYER_POP,
  LAYER_PUSH,
  RUN,
  STENCIL_POP,
  STENCIL_PUSH,
} from "./commands.js";
import {
  DRAW,
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
 * their markers say; a layer of no size is left out, all in it. Pure: the same
 * list plans the same commands.
 */
export function plan(scene: SceneList, background: number, out: Commands): void {
  out.reset();
  open.length = 0;
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

  // A run is a stretch of draws under one blend mode, outside a mask's own draws, which its
  // markers name for the stencil.
  let first = -1;
  let masking = false;
  const close = (end: number) => {
    if (first >= 0 && end > first) {
      out.push(RUN, first, end - first, scene.blend[first]);
    }

    first = -1;
  };

  for (let i = 0; i < scene.length; i++) {
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
        }

        break;
      }
    }
  }

  close(scene.length);
}

/** The layers pushed and not yet popped, by number, innermost last. */
const open: number[] = [];

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
