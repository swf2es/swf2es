import { IDLE_FRAMES } from "./geometry.js";
import { type Handle, Registry } from "./registry.js";

/** A texture as its owner holds it: its id, and the generation the id had. */
export type TextureHandle = Handle;

/**
 * A texture's size, and its pixels while they wait to be uploaded:
 * premultiplied RGBA bytes, or RGBA floats, which only a kernel reads, a
 * texel at a time.
 */
export interface TextureData {
  width: number;
  height: number;
  pixels: Uint8Array | Float32Array | null;
}

/**
 * Every texture a scene list may name, by id. An owner adds a texture's
 * pixels, and sets them again as they change; the backend uploads what is
 * pending and lets the pixels go, so none are kept on the CPU. What goes
 * undrawn for its idle frames, IDLE_FRAMES unless it was given fewer, is
 * let go of, as geometries are.
 */
export class Textures extends Registry {
  private readonly data: (TextureData | null)[] = [];
  /** Added or set again since the backend last took them. */
  pending: number[] = [];

  /** A texture of `pixels`, let go of once undrawn for `idle` frames. */
  add(
    width: number,
    height: number,
    pixels: Uint8Array | Float32Array,
    idle = IDLE_FRAMES,
  ): TextureHandle {
    const handle = this.hold(idle);
    this.data[handle.id] = { width, height, pixels };
    this.pending.push(handle.id);
    return handle;
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

  get(id: number): TextureData | null {
    return this.data[id] ?? null;
  }

  protected override dropped(id: number): void {
    this.data[id] = null;
  }
}
