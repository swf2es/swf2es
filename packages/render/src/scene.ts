/** Blend modes as a scene list names them. */
export const NORMAL = 0;

/** How an entry samples its texture: smoothed, and clamped, repeated or mirrored past its edges. */
export const SMOOTH = 1;
export const CLAMP = 0;
export const REPEAT = 2;
export const MIRROR = 4;

/**
 * A frame's drawing in order: each entry a geometry drawn under a row with
 * a blend mode, and the texture it samples (-1 for none) and how. Boundaries
 * (filters, masks, blend layers) come with the features that need them.
 */
export class SceneList {
  geometry = new Int32Array(1024);
  row = new Int32Array(1024);
  blend = new Uint8Array(1024);
  texture = new Int32Array(1024);
  sampler = new Uint8Array(1024);
  length = 0;

  reset(): void {
    this.length = 0;
  }

  draw(geometry: number, row: number, blend: number, texture = -1, sampler = 0): void {
    if (this.length === this.geometry.length) {
      this.geometry = grow(this.geometry);
      this.row = grow(this.row);
      this.blend = grow(this.blend);
      this.texture = grow(this.texture);
      this.sampler = grow(this.sampler);
    }

    const at = this.length++;
    this.geometry[at] = geometry;
    this.row[at] = row;
    this.blend[at] = blend;
    this.texture[at] = texture;
    this.sampler[at] = sampler;
  }
}

function grow<T extends Int32Array | Uint8Array>(array: T): T {
  const grown = new (array.constructor as new (length: number) => T)(array.length * 2);
  grown.set(array);
  return grown;
}
