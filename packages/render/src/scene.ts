/** Blend modes as a scene list names them. */
export const NORMAL = 0;

/**
 * A frame's drawing in order: each entry a geometry drawn under a row with
 * a blend mode. Boundaries (filters, masks, blend layers) come with the
 * features that need them.
 */
export class SceneList {
  geometry = new Int32Array(1024);
  row = new Int32Array(1024);
  blend = new Uint8Array(1024);
  length = 0;

  reset(): void {
    this.length = 0;
  }

  draw(geometry: number, row: number, blend: number): void {
    if (this.length === this.geometry.length) {
      this.geometry = grow(this.geometry);
      this.row = grow(this.row);
      this.blend = grow(this.blend);
    }

    const at = this.length++;
    this.geometry[at] = geometry;
    this.row[at] = row;
    this.blend[at] = blend;
  }
}

function grow<T extends Int32Array | Uint8Array>(array: T): T {
  const grown = new (array.constructor as new (length: number) => T)(array.length * 2);
  grown.set(array);
  return grown;
}
