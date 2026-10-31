import type { BitmapStore } from "../../bitmap/bitmap.js";

/**
 * drawToBitmapData's copy, as AIR makes it: `rgba`, the back buffer's
 * top-left `width` by `height`, top-down raw RGBA, written into the store's
 * top-left corner, the rest of the store left as it was. `backHeight` is the
 * back buffer's height.
 *
 * AIR raises alpha to the largest channel, which makes the pixel
 * premultiplied without multiplying RGB (that would darken textures twice),
 * but only over the back buffer's height of rows counted up from the
 * destination's bottom: it fixes alpha up in a bottom-up layout aligned to
 * the destination's last row. A destination taller than the back buffer
 * keeps the raw alpha in the rows above those, with or without
 * antialiasing. An opaque store keeps it as it is, as erase leaves alpha in
 * one (`holdsAlpha`). A transparent store's pixels must stay premultiplied,
 * so there each channel is clamped to alpha: AIR's getPixel32 lets a channel
 * above alpha spill into the one above (`8001fc00` for green 255 over alpha
 * 128), where ours reads `8000ff00`.
 */
export function writeReadback(
  store: BitmapStore,
  rgba: Uint8Array,
  width: number,
  height: number,
  backHeight: number,
): void {
  const pixels = store.pixels;
  const raw = store.height - backHeight;
  const transparent = store.transparent;
  const whole = width === store.width && height === store.height;
  // Whether alpha below 255 is looked for: an opaque store holds alpha once
  // it has any, until a copy rewrites all of it at 255.
  const track = !transparent && (whole || !store.holdsAlpha);
  let opaque = true;
  for (let y = 0; y < height; y++) {
    const keep = y < raw;
    const row = y * store.width;
    for (let x = 0, at = y * width * 4; x < width; x++, at += 4) {
      let r = rgba[at];
      let g = rgba[at + 1];
      let b = rgba[at + 2];
      let alpha = rgba[at + 3];
      if (!keep) {
        alpha = Math.max(r, g, b, alpha);
      } else if (transparent) {
        r = Math.min(r, alpha);
        g = Math.min(g, alpha);
        b = Math.min(b, alpha);
      }

      pixels[row + x] = (alpha << 24) | (r << 16) | (g << 8) | b;
      if (track && alpha !== 255) {
        opaque = false;
      }
    }
  }

  // Where it tracked a part of the store, the store held no alpha before.
  if (track) {
    store.holdsAlpha = !opaque;
  }

  store.changed();
}
