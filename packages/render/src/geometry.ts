/**
 * How many frames a geometry may go undrawn before it is let go of: a
 * pool's object or a loop's rarer frame comes back within a few seconds.
 */
export const IDLE_FRAMES = 300;

/** A geometry as its owner holds it: its id, and the generation the id had, which a reused id moves on. */
export interface GeometryHandle {
  id: number;
  generation: number;
}

/**
 * Triangles to draw under a row's transform: positions on the stage in
 * pixels, two floats a vertex; each vertex' straight colour, its bytes red,
 * green, blue and alpha from the lowest; where it samples a texture, where
 * in texels, two floats a vertex, which a draw divides by the texture's
 * size; and indices into the vertices, three a triangle. The backend copies
 * them into its atlas once.
 */
export interface GeometryData {
  positions: Float32Array;
  colors: Uint32Array;
  texels?: Float32Array;
  indices: Uint32Array;
}

/**
 * Every geometry a scene list may name, by id. What goes undrawn for
 * IDLE_FRAMES is let go of; its owner finds it gone by its handle and adds
 * it again. The backend takes what was added and removed since it last
 * looked (taken), and keeps its own copies.
 */
export class Geometries {
  private readonly data: (GeometryData | null)[] = [];
  private readonly generations: number[] = [];
  private readonly usedAt: number[] = [];
  private readonly free: number[] = [];
  /** Each geometry's box: its positions' least x and y, then their greatest. */
  private boxes = new Float32Array(1024);
  /** Added and removed since the backend last took them. */
  added: number[] = [];
  removed: number[] = [];
  frame = 0;

  add(data: GeometryData): GeometryHandle {
    const id = this.free.pop() ?? this.data.length;
    this.data[id] = data;
    this.generations[id] = (this.generations[id] ?? 0) + 1;
    this.usedAt[id] = this.frame;
    this.added.push(id);
    if (id * 4 >= this.boxes.length) {
      const grown = new Float32Array(Math.max(this.boxes.length * 2, id * 4 + 4));
      grown.set(this.boxes);
      this.boxes = grown;
    }

    const p = data.positions;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]);
      y0 = Math.min(y0, p[i + 1]);
      x1 = Math.max(x1, p[i]);
      y1 = Math.max(y1, p[i + 1]);
    }

    const box = this.boxes;
    box[id * 4] = x0;
    box[id * 4 + 1] = y0;
    box[id * 4 + 2] = x1;
    box[id * 4 + 3] = y1;
    return { id, generation: this.generations[id] };
  }

  /**
   * The boxes of every geometry, four floats from `id * 4`: least x and y,
   * greatest x and y; a geometry of no vertices has its least past its
   * greatest.
   */
  get box(): Float32Array {
    return this.boxes;
  }

  /** Whether `handle` still names what it was given for. */
  alive(handle: GeometryHandle): boolean {
    return this.data[handle.id] !== null && this.generations[handle.id] === handle.generation;
  }

  get(id: number): GeometryData | null {
    return this.data[id] ?? null;
  }

  /** The ids of every geometry held, in order. */
  live(): number[] {
    const ids: number[] = [];
    for (let id = 0; id < this.data.length; id++) {
      if (this.data[id]) {
        ids.push(id);
      }
    }

    return ids;
  }

  /** `id` drawn this frame. */
  use(id: number): void {
    this.usedAt[id] = this.frame;
  }

  remove(id: number): void {
    if (this.data[id]) {
      this.data[id] = null;
      this.removed.push(id);
      this.free.push(id);
    }
  }

  /** A frame ends: what went undrawn too long is let go of. */
  endFrame(): void {
    for (let id = 0; id < this.data.length; id++) {
      if (this.data[id] && this.frame - this.usedAt[id] > IDLE_FRAMES) {
        this.remove(id);
      }
    }

    this.frame++;
  }
}
