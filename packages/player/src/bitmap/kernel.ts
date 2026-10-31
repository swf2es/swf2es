// The realm's BitmapData kernels: @swf2es/native's (bitmap-kernel.ts), which
// the filters and the pixel operations compute by, in Wasm, and its draw
// kernel (draw-kernel.ts), which draws a bitmap in the normal blend mode.
import { BitmapKernel, DrawKernel } from "@swf2es/native/render";
import { releaseDxtEncoder } from "./dxt.js";

/**
 * The realm's kernel, made at the first filter or operation that needs it:
 * @swf2es/native's, in Wasm. False where the realm refused the module, as
 * a worker served with a CSP without 'wasm-unsafe-eval' may.
 */
let kernel: BitmapKernel | false | null = null;

/** The realm's kernel, made as it is first needed; null where the realm refused the module. */
export function bitmapKernel(): BitmapKernel | null {
  if (kernel === null) {
    try {
      kernel = new BitmapKernel();
    } catch {
      kernel = false;
    }
  }

  return kernel || null;
}

/** The realm's draw kernel, as `kernel` is made; false where the realm refused the module. */
let draws: DrawKernel | false | null = null;

/** The realm's kernel for draws of a bitmap, made as first needed; null where the realm refused the module. */
export function drawKernel(): DrawKernel | null {
  if (draws === null) {
    // The module compiles once for both: refused for one, it is refused for the other.
    draws = bitmapKernel() ? new DrawKernel() : false;
  }

  return draws || null;
}

/** How many frames the draw kernel keeps its instance without drawing. */
const DRAW_IDLE_FRAMES = 120;

/** The players that may draw with the draw kernel, and the frames since it last drew. */
let players = 0;
let idleFrames = 0;

/** A player began, which may draw with the draw kernel. */
export function drawKernelUsed(): void {
  players++;
}

/** A player ended: the last one lets the draw kernel's instance go, and its memory with it. */
export function drawKernelLetGo(): void {
  players = Math.max(0, players - 1);
  if (players === 0) {
    if (draws) {
      draws.release();
    }

    releaseDxtEncoder();
  }
}

/** A player's frame played: the draw kernel, idle for DRAW_IDLE_FRAMES of them, lets its instance go. */
export function drawKernelFrame(): void {
  const kernel = draws || null;
  if (!kernel?.held) {
    idleFrames = 0;
    return;
  }

  idleFrames = kernel.idle() ? idleFrames + 1 : 0;
  if (idleFrames > DRAW_IDLE_FRAMES) {
    kernel.release();
    idleFrames = 0;
  }
}
