// The realm's BitmapData kernels: @swf2es/native's (bitmap-kernel.ts), which
// the filters and the pixel operations compute by, in Wasm, and its draw
// kernel (draw-kernel.ts), which draws a bitmap in the normal blend mode.
import { BitmapKernel, DrawKernel } from "@swf2es/native/render";

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
