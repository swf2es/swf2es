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
 * The most released nodes a view keeps, of all characters, for a new
 * object of their character to take (render/view.ts), the oldest going
 * first. A crowd of 32 of one animated character releases some 340 a
 * frame and takes most of them back only as its loop comes round, a second
 * or two on: it keeps some 9,000. At 2,048 those went before they were
 * taken, and a third of the nodes were made anew.
 */
export const SPARE_NODES_MOST = 16_384;

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
/**
 * The vertices of idle lines kept to begin with, and at the least: enough
 * for most content, which never grows it (IdleBudget). A crowded room in a
 * busy SWF came back to 1.6 million within LINES_IDLE_MS; kept to this,
 * it tessellated some 21 contexts a frame again, three quarters of all it
 * allocated.
 */
export const LINES_IDLE_VERTICES = 500_000;
/**
 * The most the budget of idle lines' vertices grows to: two and a half
 * times that room's, at most some 0.5 GB of heap and GPU between them,
 * where content that comes back to more than this is better tessellated
 * again than kept.
 */
export const LINES_IDLE_VERTICES_MOST = 4_000_000;
/** The vertices of idle lines allowed for each GB of the device's memory. */
const LINES_IDLE_VERTICES_PER_GB = 500_000;
/** The share of the JavaScript heap's limit idle lines may take, at some 110 bytes a vertex. */
const LINES_IDLE_HEAP_SHARE = 1 / 8;
const BYTES_PER_LINE_VERTEX = 110;

/** What a host tells of its memory: `navigator.deviceMemory` in GB, Chrome's `performance.memory` heap limit in bytes. */
export interface DeviceMemory {
  deviceMemory?: number;
  heapLimit?: number;
}

/** The host's memory as far as it tells it; nothing outside a browser that does. */
export function deviceMemory(): DeviceMemory {
  const host = globalThis as {
    navigator?: { deviceMemory?: unknown };
    performance?: { memory?: { jsHeapSizeLimit?: unknown } };
  };
  const gb = host.navigator?.deviceMemory;
  const limit = host.performance?.memory?.jsHeapSizeLimit;
  return {
    deviceMemory: typeof gb === "number" && gb > 0 ? gb : undefined,
    heapLimit: typeof limit === "number" && limit > 0 ? limit : undefined,
  };
}

/**
 * The most the idle lines' budget may grow to on a device: a phone with a
 * heap of half a GB would lose the tab long before LINES_IDLE_VERTICES_MOST.
 * 0.5 million vertices for each GB of its memory, and an eighth of its
 * heap's limit, the less of the two it tells; never under the floor, never
 * over LINES_IDLE_VERTICES_MOST, which is also all where it tells neither.
 */
export function linesCeiling(device: DeviceMemory): number {
  let most = LINES_IDLE_VERTICES_MOST;
  if (device.deviceMemory !== undefined) {
    most = Math.min(most, LINES_IDLE_VERTICES_PER_GB * device.deviceMemory);
  }

  if (device.heapLimit !== undefined) {
    most = Math.min(most, (device.heapLimit * LINES_IDLE_HEAP_SHARE) / BYTES_PER_LINE_VERTEX);
  }

  return Math.max(LINES_IDLE_VERTICES, Math.floor(most));
}

/**
 * How much an idle pool keeps, grown as the pool turns out too small for
 * what comes back to it, and shrunk back as nothing does, as ARC's ghosts
 * size its lists. The keys of what the pool let go for room are kept a
 * while, without what they named: one asked for again while age alone
 * would still have kept it (`window` after it went idle) was let go only
 * for want of room, which grows by its size. Not grown for a window, the
 * budget's excess over `floor` halves each window, letting go of the
 * oldest idle as it does: a pool that needed the room again soon grows
 * back. Never past `ceiling`, nor under `floor`.
 */
export class IdleBudget {
  /** What the pool may keep now, in its own units (vertices, say). */
  size: number;
  /** What was let go for room, by key, the first let go first: when it went idle, and its size. */
  private readonly ghosts = new Map<string, { since: number; size: number }>();
  private grewAt = Number.NEGATIVE_INFINITY;
  private tickedAt = Number.NEGATIVE_INFINITY;

  constructor(
    readonly floor: number,
    readonly ceiling: number,
    readonly window: number,
    /** The most keys remembered, the first let go going first. */
    readonly ghostsMost: number,
  ) {
    this.size = floor;
  }

  /** How many keys are remembered. */
  get remembered(): number {
    return this.ghosts.size;
  }

  /** `key`, idle since `since` and `size` large, let go for room. */
  evicted(key: string, since: number, size: number): void {
    this.ghosts.delete(key);
    this.ghosts.set(key, { since, size });
    if (this.ghosts.size > this.ghostsMost) {
      this.ghosts.delete(this.ghosts.keys().next().value as string);
    }
  }

  /** `key` made anew at `now`: if it went only for room, the budget was short by its size. */
  missed(key: string, now: number): void {
    const ghost = this.ghosts.get(key);
    if (!ghost) {
      return;
    }

    this.ghosts.delete(key);
    if (now - ghost.since < this.window) {
      this.size = Math.min(this.ceiling, this.size + ghost.size);
      this.grewAt = now;
    }
  }

  /** Time passed to `now`: the keys age alone would have let go are forgotten, and the budget shrinks if it may. */
  tick(now: number): void {
    // In the order let go, which is near enough that of going idle: one young enough stops it.
    for (const [key, ghost] of this.ghosts) {
      if (now - ghost.since < this.window) {
        break;
      }

      this.ghosts.delete(key);
    }

    const since = Math.max(this.tickedAt, this.grewAt + this.window);
    this.tickedAt = now;
    if (now > since && this.size > this.floor) {
      const excess = (this.size - this.floor) * 2 ** (-(now - since) / this.window);
      this.size = excess < 1 ? this.floor : this.floor + excess;
    }
  }
}
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
