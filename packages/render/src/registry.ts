/** What a registry holds as its owner holds it: its id, and the generation the id had. */
export interface Handle {
  id: number;
  generation: number;
}

/**
 * Ids for what a frame may name, handed out and taken back: a reused id is
 * a new generation, which an old handle does not name; what goes unused
 * for its idle frames is removed; the backend takes what was removed since
 * it last looked. Geometries, textures and kept outputs are each one.
 */
export class Registry {
  private readonly generations: number[] = [];
  private readonly usedAt: number[] = [];
  private readonly idleFrames: number[] = [];
  private readonly held: boolean[] = [];
  private readonly free: number[] = [];
  /** Removed since the backend last took them. */
  removed: number[] = [];
  frame = 0;

  /** A new id, removed once unused for `idle` frames. */
  protected hold(idle: number): Handle {
    const id = this.free.pop() ?? this.held.length;
    this.held[id] = true;
    this.generations[id] = (this.generations[id] ?? 0) + 1;
    this.usedAt[id] = this.frame;
    this.idleFrames[id] = idle;
    return { id, generation: this.generations[id] };
  }

  /** Whether `handle` still names what it was given for. */
  alive(handle: Handle): boolean {
    return this.held[handle.id] === true && this.generations[handle.id] === handle.generation;
  }

  /** Whether `id` names anything now. */
  holds(id: number): boolean {
    return this.held[id] === true;
  }

  /** How many ids there have been, the free ones among them. */
  get size(): number {
    return this.held.length;
  }

  /** How many ids name something now. */
  get count(): number {
    return this.held.length - this.free.length;
  }

  /** `id` let go of after `idle` unused frames, where that is fewer than it was given. */
  idleWithin(id: number, idle: number): void {
    if (this.held[id] && idle < this.idleFrames[id]) {
      this.idleFrames[id] = idle;
    }
  }

  /** `id` used this frame. */
  use(id: number): void {
    this.usedAt[id] = this.frame;
  }

  remove(id: number): void {
    if (this.held[id]) {
      this.held[id] = false;
      this.removed.push(id);
      this.free.push(id);
      this.dropped(id);
    }
  }

  /** What `id` held, let go of as it is removed. */
  protected dropped(_id: number): void {}

  /** Everything let go of, as a lost context took it: the owners add it again. */
  lost(): void {
    for (let id = 0; id < this.held.length; id++) {
      this.remove(id);
    }
  }

  /** A frame ends: what went unused too long is let go of. */
  endFrame(): void {
    for (let id = 0; id < this.held.length; id++) {
      if (this.held[id] && this.frame - this.usedAt[id] > this.idleFrames[id]) {
        this.remove(id);
      }
    }

    this.frame++;
  }
}
