// Pixi's batchers of groups that went, kept for new groups to build with;
// and the batchers of groups that stay, cut back once they hold far more
// than they use.
import {
  type Batcher,
  type Buffer,
  type InstructionSet,
  type Renderer,
  RendererType,
  ViewableBuffer,
} from "pixi.js";

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

/** Buffers smaller than this, attributes and indices together, are never cut back: not worth a copy. */
const TRIM_FLOOR = 1 << 16;
/**
 * How long a batcher may use under a quarter of its buffers before they
 * are cut back to twice its use. Pixi only grows them, to twice the most a
 * build ever packed: a group that once held a crowd's settled Graphics, or
 * that took a larger group's spare batchers, kept megabytes for the few
 * vertices it packs since. By time, so that a group not rebuilt is cut back
 * too, and long enough that one whose use swings comes back to its peak
 * first.
 */
const TRIM_MS = 3000;
/** When each batcher was first seen using under a quarter of its buffers, since it last used more. */
const lowSince = new WeakMap<Batcher, number>();

type Packing = Batcher & { attributeSize: number; indexSize: number };

/** Cut back the buffers of the batchers of `renderer`'s groups that have long used little of them. */
export function trimBatchers(renderer: Renderer, now: number): void {
  const sets = (renderer.renderPipes?.batch as unknown as BatchPipe | undefined)
    ?._batchersByInstructionSet;
  if (!sets) {
    return;
  }

  for (const uid in sets) {
    const batchers = sets[uid];
    for (const name in batchers) {
      trim(renderer, batchers[name] as Packing, now);
    }
  }
}

function trim(renderer: Renderer, batcher: Packing, now: number): void {
  const attributes = batcher.attributeBuffer;
  const indices = batcher.indexBuffer;
  // Destroyed, or yet to build.
  if (!attributes || !indices || !batcher.geometry) {
    return;
  }

  const floats = batcher.attributeSize || 0;
  const count = batcher.indexSize || 0;
  const held = attributes.size + indices.byteLength;
  const used = floats * 4 + count * indices.BYTES_PER_ELEMENT;
  if (held < TRIM_FLOOR || used * 4 > held) {
    lowSince.delete(batcher);
    return;
  }

  const since = lowSince.get(batcher);
  if (since === undefined) {
    lowSince.set(batcher, now);
    return;
  }

  if (now - since < TRIM_MS) {
    return;
  }

  lowSince.delete(batcher);
  // What the last build packed is copied: a group not rebuilt draws it again, and an element
  // updated in place writes where it was.
  const packed = new ViewableBuffer(Math.max(floats * 2, 4) * 4);
  packed.float32View.set(attributes.float32View.subarray(0, floats));
  const length = Math.max(count * 2, 6);
  const indexed = new (indices.constructor as Uint16ArrayConstructor)(length + (length % 2));
  indexed.set(indices.subarray(0, count));
  attributes.destroy();
  batcher.attributeBuffer = packed;
  batcher.indexBuffer = indexed;
  const geometry = batcher.geometry;
  resize(renderer, geometry.buffers[0]);
  resize(renderer, geometry.indexBuffer);
  geometry.buffers[0].setDataWithSize(packed.float32View, floats, true);
  geometry.indexBuffer.setDataWithSize(indexed, count, true);
}

/**
 * Have WebGL's copy of `buffer` made again at the size of its next data:
 * Pixi only ever writes a smaller array into the GPU's larger one. A lost
 * context's buffers are made again anyway.
 */
function resize(renderer: Renderer, buffer: Buffer): void {
  if (renderer.type !== RendererType.WEBGL) {
    return;
  }

  const gpu = (buffer as unknown as { _gpuData: Record<number, { byteLength: number } | null> })
    ._gpuData[renderer.uid];
  if (gpu) {
    gpu.byteLength = -1;
  }
}
