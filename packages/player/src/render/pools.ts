// What the view and Pixi keep for reuse, and how much of it: Pixi's own
// pools never shrink, so they are cut back as a view prepares.
import { BatchableGraphics, BigPool, GraphicsContextRenderData, RenderTexture } from "pixi.js";

/**
 * The most Graphics a view keeps for the next content to take, of children
 * taken off: a frame-by-frame timeline takes its children off and puts new
 * ones on every frame, each made and destroyed with its Graphics.
 */
export const SPARE_GRAPHICS_MOST = 4096;

/**
 * How long, in milliseconds, what no instance uses is kept for one to come
 * back to, as a loop does. By age, not count: a loop longer than a count
 * would find each gone just before it came round to it; and by time, not
 * renders, which a host may make many of between a SWF's frames.
 */
export const IDLE_MS = 5000;
/**
 * How long lines' contexts no instance uses are kept, how many at most,
 * and how many of their vertices, some 110 bytes each on the heap and 30
 * on the GPU. Longer than IDLE_MS: animations come back to a stretch after
 * seconds, a crowd's rarer ones (an attack, a fall) after tens of them,
 * and kept 5 s, a third of a crowded room's new lines were ones it had
 * made before. Not past Pixi's minute, after which it lets an unused
 * context's geometry go, to be tessellated again anyway.
 */
export const LINES_IDLE_MS = 30_000;
export const LINES_IDLE_MOST = 4096;
export const LINES_IDLE_VERTICES = 500_000;
/**
 * The most objects off the list kept whole: enough for a pool or a panel,
 * while a timeline that makes its children anew on every frame lets its
 * last frames' go, whose Graphics in thousands made long collector pauses.
 */
export const PARKED_MOST = 1024;
/** First-time detached groups get one chance to return without letting churn fill the batch cache. */
export const PARKED_FIRST_GROUPS_MOST = 64;
/**
 * The most render data Pixi may keep pooled from the contexts that went.
 * Pixi pools each unbatched context's render data, a batcher with its
 * buffers at their largest, and never shrinks the pool: lines drawn again
 * for a window resized, hundreds a frame, left 100 MB of buffers behind.
 * Pixi reads a context's render data afresh on each draw, so a pooled one
 * is no one's. Its pooled batch elements are left: their geometry is
 * emptied as they are pooled, and a batch may still list them.
 */
const POOLED_RENDER_DATA_MOST = 128;
/**
 * The most batch elements of Graphics Pixi may keep pooled. Pixi pools one
 * for each batch each context makes and never shrinks the pool: a crowded
 * room left 165,000 behind it. They are let go of rather than destroyed,
 * as a batch may still list one: that one lives on while it does.
 */
const POOLED_BATCHABLES_MOST = 4096;

/**
 * The render textures draws render through, oldest first, kept for the
 * next draw of the same size: a bitmap drawn again on every move of the
 * pointer, as a colour picker's is, then makes and frees no texture each
 * time. At most DRAW_TARGETS_MOST and DRAW_TARGET_TEXELS, the oldest going
 * first, and none kept idle past IDLE_MS: a draw of the whole stage at four
 * samples a pixel is tens of megabytes no other draw may want.
 */
const DRAW_TARGETS_MOST = 8;
const DRAW_TARGET_TEXELS = 4 * 1024 * 1024;
const drawTargets: { texture: RenderTexture; since: number }[] = [];

export function drawTarget(width: number, height: number): RenderTexture {
  for (let i = drawTargets.length - 1; i >= 0; i--) {
    const { texture } = drawTargets[i];
    if (texture.width === width && texture.height === height) {
      drawTargets.splice(i, 1);
      return texture;
    }
  }

  return RenderTexture.create({ width, height });
}

/** A draw's target done with: kept for the next draw of its size, the oldest kept going past the most. */
export function releaseDrawTarget(texture: RenderTexture): void {
  drawTargets.push({ texture, since: performance.now() });
  let texels = 0;
  for (const kept of drawTargets) {
    texels += kept.texture.width * kept.texture.height;
  }

  while (drawTargets.length > DRAW_TARGETS_MOST || texels > DRAW_TARGET_TEXELS) {
    const oldest = drawTargets.shift() as (typeof drawTargets)[number];
    texels -= oldest.texture.width * oldest.texture.height;
    oldest.texture.destroy(true);
  }
}

/**
 * Pixi's pool of render data destroyed contexts gave back, emptied once
 * past its most, and its batch elements of Graphics cut back to theirs;
 * what is in use stays. And the draws' targets kept idle too long.
 */
export function trimPools(): void {
  const data = BigPool.getPool(GraphicsContextRenderData);
  if (data.totalFree > POOLED_RENDER_DATA_MOST) {
    data.clear();
  }

  // Pool's fields: its items, how many are free (the first of them), and how many it made.
  const batchables = BigPool.getPool(BatchableGraphics) as unknown as {
    _pool: unknown[];
    _index: number;
    _count: number;
  };
  const extra = batchables._index - POOLED_BATCHABLES_MOST;
  if (extra > 0) {
    batchables._index = POOLED_BATCHABLES_MOST;
    batchables._count -= extra;
    batchables._pool.length = POOLED_BATCHABLES_MOST;
  }

  // Past the free ones are those taken, which Pixi leaves listed: their users hold them, if anyone.
  // Cut once they are many, not on every frame, which would shrink and regrow the list each time.
  if (batchables._pool.length > batchables._index + POOLED_BATCHABLES_MOST) {
    batchables._pool.length = batchables._index;
  }

  const now = performance.now();
  while (drawTargets.length > 0 && now - drawTargets[0].since > IDLE_MS) {
    drawTargets.shift()?.texture.destroy(true);
  }
}
