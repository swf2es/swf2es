// BitmapData.draw on the GPU: a display object drawn alone by a fresh view
// of the stage's (PixiView.forDraw), at several samples a pixel, and
// averaged down to the BitmapData's pixels, read back or drawn into its
// store's texture.
import { Container as PixiContainer, type RenderTexture, Sprite } from "pixi.js";
import type { BitmapStore } from "../bitmap/bitmap.js";
import type { DisplayObject } from "../display/display.js";
import { argbOf, gpuBitmaps } from "./bitmaps.js";
import { drawTarget, releaseDrawTarget } from "./pools.js";
import type { PixiView } from "./view.js";

type Affine = { a: number; b: number; c: number; d: number; tx: number; ty: number };

/**
 * `o` drawn alone, as BitmapData.draw takes a display object: through `m`
 * into a w x h texture, rendered at `samples` a side and averaged on the
 * GPU, as Flash covers edges (4 at its high quality). A fresh view does
 * it, borrowing the stage's current geometry, so the stage's is untouched.
 */
function sampled(
  stage: PixiView,
  o: DisplayObject,
  m: Affine,
  width: number,
  height: number,
  samples: number,
): RenderTexture {
  const renderer = stage.renderer;
  const n = samples;
  const view = stage.forDraw(o, n);
  const bitmaps = gpuBitmaps(renderer);
  const smoothing = bitmaps.smoothing;
  // Built at the draw's own scale, lines included, as the stage's are,
  // then rendered n times larger: the curves are no finer than on the
  // stage, and widths and hairlines scale with the samples.
  // What the view built is destroyed, and the targets given back, though a render throws.
  const scaled = new PixiContainer();
  let target = drawTarget(width * n, height * n);
  try {
    // At low quality, a sample a pixel, as the stage's at low, no bitmap is smoothed.
    bitmaps.smoothing = n > 1;
    view.drawAlone(o, m, scaled);
    scaled.scale.set(n);
    renderer.render({ container: scaled, target, clear: true });
  } catch (error) {
    releaseDrawTarget(target);
    throw error;
  } finally {
    view.dispose(scaled);
    bitmaps.smoothing = smoothing;
  }

  // Halved until a sample a pixel: a linear sample at the corner four texels share is their mean.
  for (let k = n; k > 1; k /= 2) {
    const half = drawTarget((width * k) / 2, (height * k) / 2);
    target.source.scaleMode = "linear";
    const sprite = new Sprite(target);
    sprite.scale.set(0.5);
    try {
      renderer.render({ container: sprite, target: half, clear: true });
    } catch (error) {
      releaseDrawTarget(half);
      throw error;
    } finally {
      sprite.destroy();
      releaseDrawTarget(target);
    }

    target = half;
  }

  return target;
}

/** `o` drawn alone by `stage`'s fresh view, as `sampled`, read back as premultiplied ARGB. */
export function snapshot(
  stage: PixiView,
  o: DisplayObject,
  m: Affine,
  width: number,
  height: number,
  samples: number,
): Uint32Array {
  const target = sampled(stage, o, m, width, height, samples);
  const pixels = argbOf(stage.renderer.extract.pixels(target).pixels);
  releaseDrawTarget(target);
  return pixels;
}

/**
 * `o` drawn into `store` on the GPU, as `sampled`, source over at (x, y)
 * with nothing read back: the store is then newer on the GPU. False,
 * having done nothing, where the store can have no texture.
 */
export function drawInto(
  stage: PixiView,
  store: BitmapStore,
  o: DisplayObject,
  m: Affine,
  x: number,
  y: number,
  width: number,
  height: number,
  samples: number,
): boolean {
  const renderer = stage.renderer;
  const bitmaps = gpuBitmaps(renderer);
  const texture = bitmaps.texture(store);
  if (!texture) {
    return false;
  }

  // Into a texture of its own first: the object may show the store itself.
  const drawn = sampled(stage, o, m, width, height, samples);
  const sprite = new Sprite(drawn);
  sprite.position.set(x, y);
  renderer.render({ container: sprite, target: texture, clear: false });
  sprite.destroy();
  releaseDrawTarget(drawn);
  bitmaps.drawn(store);
  return true;
}
