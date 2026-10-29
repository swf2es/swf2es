import { CLEAR, type Commands, RUN } from "./commands.js";
import type { SceneList } from "./scene.js";

/**
 * Plan a frame: clear to `background` (0xAARRGGBB, straight), then a run
 * for each stretch of the list under one blend mode. Pure: the same list
 * plans the same commands.
 */
export function plan(scene: SceneList, background: number, out: Commands): void {
  out.reset();
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

  let first = 0;
  for (let i = 1; i <= scene.length; i++) {
    if (i === scene.length || scene.blend[i] !== scene.blend[first]) {
      if (i > first) {
        out.push(RUN, first, i - first, scene.blend[first]);
      }

      first = i;
    }
  }
}
