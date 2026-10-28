/** A kept output as its owner holds it: its id, and the generation the id had. */
export interface KeepHandle {
  id: number;
  generation: number;
}

/** Frames a kept output may go undrawn before it is let go of. */
export const KEEP_IDLE_FRAMES = 60;

/**
 * The layers kept from one frame to the next, as Flash keeps a filtered
 * object's bitmap while nothing in it changed: an owner adds one, names it
 * on the layer whose output it keeps, and composites it again while it
 * stands (SceneList.keptLayer). The backend holds their targets, and lets
 * go of those removed; what goes undrawn for KEEP_IDLE_FRAMES is removed.
 */
export class Keeps {
  private readonly generations: number[] = [];
  private readonly usedAt: number[] = [];
  private readonly live: boolean[] = [];
  private readonly free: number[] = [];
  /** Removed since the backend last took them. */
  removed: number[] = [];
  frame = 0;

  add(): KeepHandle {
    const id = this.free.pop() ?? this.live.length;
    this.live[id] = true;
    this.generations[id] = (this.generations[id] ?? 0) + 1;
    this.usedAt[id] = this.frame;
    return { id, generation: this.generations[id] };
  }

  alive(handle: KeepHandle): boolean {
    return this.live[handle.id] === true && this.generations[handle.id] === handle.generation;
  }

  use(id: number): void {
    this.usedAt[id] = this.frame;
  }

  remove(id: number): void {
    if (this.live[id]) {
      this.live[id] = false;
      this.removed.push(id);
      this.free.push(id);
    }
  }

  /** Every kept output let go of, as a lost context took them. */
  lost(): void {
    for (let id = 0; id < this.live.length; id++) {
      this.remove(id);
    }
  }

  endFrame(): void {
    for (let id = 0; id < this.live.length; id++) {
      if (this.live[id] && this.frame - this.usedAt[id] > KEEP_IDLE_FRAMES) {
        this.remove(id);
      }
    }

    this.frame++;
  }
}
