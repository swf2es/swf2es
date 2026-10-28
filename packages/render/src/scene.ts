/**
 * Blend modes as a scene list names them, in Flash's order: the separable
 * ones blend straight colours, the rest have formulas of their own.
 */
export const NORMAL = 0;
export const LAYER = 1;
export const MULTIPLY = 2;
export const SCREEN = 3;
export const LIGHTEN = 4;
export const DARKEN = 5;
export const DIFFERENCE = 6;
export const ADD = 7;
export const SUBTRACT = 8;
export const INVERT = 9;
export const ALPHA = 10;
export const ERASE = 11;
export const OVERLAY = 12;
export const HARDLIGHT = 13;

/** Flash's blend mode names, by their number here. */
export const BLEND_NAMES = [
  "normal",
  "layer",
  "multiply",
  "screen",
  "lighten",
  "darken",
  "difference",
  "add",
  "subtract",
  "invert",
  "alpha",
  "erase",
  "overlay",
  "hardlight",
];

/**
 * What an entry is: a draw, or a mask's marker. A mask's own draws lie
 * between its MASK_BEGIN and its MASK_USE, which names them (its geometry
 * the first, its row how many) for the planner to push them into the
 * stencil; what it masks follows, up to the MASK_POP that names them again
 * to take them out.
 */
export const DRAW = 0;
export const MASK_BEGIN = 1;
export const MASK_USE = 2;
export const MASK_POP = 3;
/**
 * A layer: what lies between LAYER_BEGIN and LAYER_END is drawn into a
 * target of its own, then composited onto what is below in the END's blend
 * mode (its geometry), its colour transform the END's row, or none (-1).
 */
export const LAYER_BEGIN = 4;
export const LAYER_END = 5;

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
  kind = new Uint8Array(1024);
  length = 0;

  reset(): void {
    this.length = 0;
  }

  draw(geometry: number, row: number, blend: number, texture = -1, sampler = 0): void {
    this.push(DRAW, geometry, row, blend, texture, sampler);
  }

  /** A mask's marker; MASK_USE and MASK_POP name its draws, from `first`, `count` of them. */
  marker(kind: number, first = 0, count = 0): void {
    this.push(kind, first, count, 0, -1, 0);
  }

  private push(
    kind: number,
    geometry: number,
    row: number,
    blend: number,
    texture: number,
    sampler: number,
  ): void {
    if (this.length === this.geometry.length) {
      this.geometry = grow(this.geometry);
      this.row = grow(this.row);
      this.blend = grow(this.blend);
      this.texture = grow(this.texture);
      this.sampler = grow(this.sampler);
      this.kind = grow(this.kind);
    }

    const at = this.length++;
    this.kind[at] = kind;
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
