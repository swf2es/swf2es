// Pixi's batchers of groups that went, kept for new groups to build with.
import type { Batcher, InstructionSet, Renderer } from "pixi.js";

/** Pixi's batch pipe, which keeps batchers by instruction-set ID until told to destroy them. */
interface BatchPipe {
  _batchersByInstructionSet: Record<number, Record<string, Batcher> | undefined>;
  buildStart(set: InstructionSet): void;
}

/** Retired groups' batchers kept, at most this many groups', for new groups to build with. */
const SPARE_BATCHERS_MOST = 16;
const spareBatchersOf = new WeakMap<Renderer, Record<string, Batcher>[]>();
/**
 * The instruction sets of groups a view made, the only ones given spare batchers: a root rendered
 * once, as BitmapData.draw's, is destroyed with whatever it was given.
 */
export const viewGroups = new WeakSet<InstructionSet>();

/**
 * Take a retired instruction set's batchers from Pixi, which keeps them by ID even after its group
 * is gone. A branch made anew each frame would otherwise allocate a group's buffers as an older
 * one's are freed, which costs more than keeping them all; a new group takes them over instead.
 */
export function retireBatchers(renderer: Renderer, uid: number): void {
  const pipe = renderer.renderPipes?.batch as unknown as BatchPipe | undefined;
  const batchers = pipe?._batchersByInstructionSet?.[uid];
  if (!pipe || !batchers) {
    return;
  }

  delete pipe._batchersByInstructionSet[uid];
  let spare = spareBatchersOf.get(renderer);
  if (!spare) {
    const list: Record<string, Batcher>[] = [];
    const buildStart = pipe.buildStart;
    pipe.buildStart = function (this: BatchPipe, set: InstructionSet) {
      if (!this._batchersByInstructionSet[set.uid] && list.length > 0 && viewGroups.has(set)) {
        this._batchersByInstructionSet[set.uid] = list.pop();
      }

      buildStart.call(this, set);
    };
    spare = list;
    spareBatchersOf.set(renderer, spare);
  }

  if (spare.length < SPARE_BATCHERS_MOST) {
    spare.push(batchers);
    return;
  }

  for (const batcher of Object.values(batchers)) {
    batcher.destroy();
  }
}
