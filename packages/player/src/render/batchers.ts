// Pixi's batchers of groups that went, kept for new groups to build with.
import type { Batcher, BatcherPipe, InstructionSet, Renderer } from "pixi.js";

/** Retired groups' batchers kept, at most this many groups', for new groups to build with. */
const SPARE_BATCHERS_MOST = 16;
const spareBatchersOf = new WeakMap<BatcherPipe, Record<string, Batcher>[]>();
/**
 * The instruction sets of groups a view made, the only ones given spare batchers: a root rendered
 * once, as BitmapData.draw's, is destroyed with whatever it was given.
 */
export const viewGroups = new WeakSet<InstructionSet>();

/** The batch pipe of `renderer`, which keeps batchers by instruction set. */
function batchPipeOf(renderer: Renderer): BatcherPipe | undefined {
  return renderer.renderPipes?.batch as BatcherPipe | undefined;
}

/**
 * The batchers a group's new instruction set builds with (render/hooks.ts): a retired group's,
 * for a set a view made, or none, for Pixi to make new ones.
 */
export function spareBatchersFor(
  pipe: BatcherPipe,
  set: InstructionSet,
): Record<string, Batcher> | undefined {
  const spare = spareBatchersOf.get(pipe);
  return spare && spare.length > 0 && viewGroups.has(set) ? spare.pop() : undefined;
}

/**
 * Take a retired instruction set's batchers from Pixi, which keeps them by ID even after its group
 * is gone. A branch made anew each frame would otherwise allocate a group's buffers as an older
 * one's are freed, which costs more than keeping them all; a new group takes them over instead.
 */
export function retireBatchers(renderer: Renderer, uid: number): void {
  const pipe = batchPipeOf(renderer);
  const batchers = pipe?.takeBatchers?.(uid);
  if (!pipe || !batchers) {
    return;
  }

  let spare = spareBatchersOf.get(pipe);
  if (!spare) {
    spare = [];
    spareBatchersOf.set(pipe, spare);
  }

  if (spare.length < SPARE_BATCHERS_MOST) {
    spare.push(batchers);
    return;
  }

  for (const batcher of Object.values(batchers)) {
    batcher.destroy();
  }
}

/**
 * Cut back the buffers of the batchers of `renderer`'s groups that have long used little of them
 * (Pixi's BatcherPipe.trim).
 */
export function trimBatchers(renderer: Renderer, now: number): void {
  batchPipeOf(renderer)?.trim?.(now);
}
