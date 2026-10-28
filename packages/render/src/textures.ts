import { IDLE_FRAMES } from "./geometry.js";

/** A texture as its owner holds it: its id, and the generation the id had. */
export interface TextureHandle {
  id: number;
  generation: number;
}

/** A texture's size, and its pixels while they wait to be uploaded: premultiplied RGBA bytes. */
export interface TextureData {
  width: number;
  height: number;
  pixels: Uint8Array | null;
}

/**
 * Every texture a scene list may name, by id. An owner adds a texture's
 * pixels, and sets them again as they change; the backend uploads what is
 * pending and lets the pixels go, so none are kept on the CPU. What goes
 * undrawn for its idle frames, IDLE_FRAMES unless it was given fewer, is
 * let go of, as geometries are.
 */
export class Textures {
  private readonly data: (TextureData | null)[] = [];
  private readonly generations: number[] = [];
  private readonly usedAt: number[] = [];
  private readonly idleFrames: number[] = [];
  private readonly free: number[] = [];
  /** Added or set again, and removed, since the backend last took them. */
  pending: number[] = [];
  removed: number[] = [];
  frame = 0;

  /** A texture of `pixels`, let go of once undrawn for `idle` frames. */
  add(width: number, height: number, pixels: Uint8Array, idle = IDLE_FRAMES): TextureHandle {
    const id = this.free.pop() ?? this.data.length;
    this.data[id] = { width, height, pixels };
    this.generations[id] = (this.generations[id] ?? 0) + 1;
    this.usedAt[id] = this.frame;
    this.idleFrames[id] = idle;
    this.pending.push(id);
    return { id, generation: this.generations[id] };
  }

  /** `id`'s pixels changed, its size with them perhaps. */
  set(id: number, width: number, height: number, pixels: Uint8Array): void {
    const data = this.data[id];
    if (data) {
      data.width = width;
      data.height = height;
      data.pixels = pixels;
      this.pending.push(id);
    }
  }

  alive(handle: TextureHandle): boolean {
    return this.data[handle.id] != null && this.generations[handle.id] === handle.generation;
  }

  get(id: number): TextureData | null {
    return this.data[id] ?? null;
  }

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

  /** Every texture let go of, as a lost context took them: their owners add them again. */
  lost(): void {
    for (let id = 0; id < this.data.length; id++) {
      this.remove(id);
    }
  }

  endFrame(): void {
    for (let id = 0; id < this.data.length; id++) {
      if (this.data[id] && this.frame - this.usedAt[id] > this.idleFrames[id]) {
        this.remove(id);
      }
    }

    this.frame++;
  }
}
