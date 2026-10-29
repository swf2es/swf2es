// The realm's BitmapData kernel: @swf2es/native's (bitmap-kernel.ts), which
// the filters and the pixel operations compute by, in Wasm.
import { BitmapKernel } from "@swf2es/native/render";

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
