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
 * How many frames a texture keeps the bytes it was last set from without
 * being set again, and spare bytes wait for another texture: a texture set
 * every frame, as a BitmapData drawn into every frame is, is converted into
 * the same bytes each time; one that stops changing lets them go a couple
 * of seconds later.
 */
export const KEEP_FRAMES = 60;

/** The spare bytes kept at most, the least lately spared let go of first. */
const SPARE_BYTES = 32 << 20;

/**
 * Every texture a scene list may name, by id. An owner adds a texture's
 * pixels, and sets them again as they change; the backend uploads what is
 * pending in its next render and lets the pixels go, keeping no hold on
 * them. What goes undrawn for its idle frames, IDLE_FRAMES unless it was
 * given fewer, is let go of, as geometries are.
 *
 * The bytes an owner fills to add or set a texture come from `bytes`, and
 * stay this registry's: filled, they are passed to add or set at once and
 * left be after, as they are lent again, to the same texture to be set again
 * or, once it let them go, to another. A texture set again keeps the bytes it
 * was last set from for KEEP_FRAMES; then, or once uploaded for one only
 * added, or when it is removed, idle or with a lost context, they are spare
 * for as long, for the next texture of their length.
 */
export class Textures extends Registry {
  private readonly data: (TextureData | null)[] = [];
  /** The bytes each texture was last added or set from, where `bytes` lent them, and the frame. */
  private readonly kept: (Uint8Array | null)[] = [];
  private readonly setAt: number[] = [];
  /** Whether each texture was set again since it was added, which keeps its bytes for a while. */
  private readonly changing: boolean[] = [];
  /** Bytes no texture keeps, by length, the least lately spared first. */
  private readonly spare = new Map<number, { bytes: Uint8Array; at: number }[]>();
  private spareBytes = 0;
  private readonly lent = new WeakSet<Uint8Array>();
  /** Added or set again since the backend last took them. */
  pending: number[] = [];

  /**
   * `length` bytes to fill and add or set a texture from: those texture `id`
   * keeps where they are as long, else spare ones, else new.
   */
  bytes(length: number, id = -1): Uint8Array {
    const own = id >= 0 && this.holds(id) ? this.kept[id] : null;
    if (own?.length === length) {
      return own;
    }

    const spare = this.spare.get(length)?.pop();
    if (spare) {
      this.spareBytes -= length;
      return spare.bytes;
    }

    const bytes = new Uint8Array(length);
    this.lent.add(bytes);
    return bytes;
  }

  /** A texture of `pixels`, let go of once undrawn for `idle` frames. */
  add(
    width: number,
    height: number,
    pixels: Uint8Array | Float32Array,
    idle = IDLE_FRAMES,
  ): TextureHandle {
    const handle = this.hold(idle);
    this.data[handle.id] = { width, height, pixels };
    this.keep(handle.id, pixels);
    this.changing[handle.id] = false;
    this.pending.push(handle.id);
    return handle;
  }

  /**
   * `id`'s pixels changed, its size with them perhaps; with `idle`, it is
   * let go of after as many undrawn frames where that is fewer.
   */
  set(id: number, width: number, height: number, pixels: Uint8Array, idle?: number): void {
    const data = this.data[id];
    if (data) {
      data.width = width;
      data.height = height;
      data.pixels = pixels;
      this.keep(id, pixels);
      this.changing[id] = true;
      this.pending.push(id);
      if (idle !== undefined) {
        this.idleWithin(id, idle);
      }
    }
  }

  get(id: number): TextureData | null {
    return this.data[id] ?? null;
  }

  /** The bytes held on the CPU: those textures keep, and spare ones. */
  get heldBytes(): number {
    let held = this.spareBytes;
    for (const bytes of this.kept) {
      held += bytes?.length ?? 0;
    }

    return held;
  }

  /** A frame ends: what went unused too long is let go of, and bytes kept no longer needed spared. */
  override endFrame(): void {
    super.endFrame();
    for (let id = 0; id < this.kept.length; id++) {
      const bytes = this.kept[id];
      const done = !this.changing[id] || this.frame - this.setAt[id] > KEEP_FRAMES;
      // Never while they wait to be uploaded, as they may where the backend drew no frame.
      if (bytes && done && this.data[id]?.pixels !== bytes) {
        this.kept[id] = null;
        this.spareOf(bytes);
      }
    }

    for (const [length, list] of this.spare) {
      while (list.length && this.frame - list[0].at > KEEP_FRAMES) {
        list.shift();
        this.spareBytes -= length;
      }
    }
  }

  protected override dropped(id: number): void {
    this.data[id] = null;
    const bytes = this.kept[id];
    this.kept[id] = null;
    if (bytes) {
      this.spareOf(bytes);
    }
  }

  /** `pixels` kept for `id` where `bytes` lent them; those it kept before spared. */
  private keep(id: number, pixels: Uint8Array | Float32Array): void {
    const before = this.kept[id];
    const own = pixels instanceof Uint8Array && this.lent.has(pixels) ? pixels : null;
    if (before && before !== own) {
      this.spareOf(before);
    }

    this.kept[id] = own;
    this.setAt[id] = this.frame;
  }

  private spareOf(bytes: Uint8Array): void {
    if (bytes.length > SPARE_BYTES) {
      return;
    }

    let list = this.spare.get(bytes.length);
    if (!list) {
      list = [];
      this.spare.set(bytes.length, list);
    }

    list.push({ bytes, at: this.frame });
    this.spareBytes += bytes.length;
    // Past the cap, the least lately spared go, whatever their length.
    while (this.spareBytes > SPARE_BYTES) {
      let oldest = -1;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [length, entries] of this.spare) {
        if (entries.length && entries[0].at < oldestAt) {
          oldestAt = entries[0].at;
          oldest = length;
        }
      }

      this.spare.get(oldest)?.shift();
      this.spareBytes -= oldest;
    }
  }
}
