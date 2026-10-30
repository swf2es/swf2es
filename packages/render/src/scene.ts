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
 * target of its own over a rectangle of the target, then composited onto
 * what is below in the END's blend mode (its geometry), its colour
 * transform the END's row, or none (-1), after the END's chain of filters
 * (its texture, or none, -1) runs over it. The BEGIN's geometry is the
 * layer's number, whose rectangle measureLayers finds.
 */
export const LAYER_BEGIN = 4;
export const LAYER_END = 5;
/**
 * A layer kept from a frame before (Keeps) composited again, over the
 * rectangle of its layer number (its geometry), in its blend mode, its
 * colour transform its row; its texture the kept one's id.
 */
export const KEPT = 6;

/** How an entry samples its texture: smoothed, and clamped, repeated or mirrored past its edges. */
export const SMOOTH = 1;
export const CLAMP = 0;
export const REPEAT = 2;
export const MIRROR = 4;
/**
 * Drawn as drawTriangles' textured triangles are: its texels each
 * vertex's u and v from 0 to 1, interpolated in perspective by the depth
 * (t) it carries (GeometryData.depths), and the texture read as Flash
 * reads it, once a pixel of Flash's (webgl/programs.ts, meshFragment).
 */
export const MESH = 8;
/**
 * A 3D object's quad: drawn by the mesh program, its texture the kept
 * output (Keeps) its bitmap was drawn into (WebGLBackend.drawPlane), its
 * texels in that bitmap's texels, read smoothed at the centre of each pixel
 * of Flash's, as Flash reads it.
 */
export const PLANE = 16;
/**
 * Its vertices placed on quarters of a pixel of Flash's, ties to even, as
 * Flash places a glyph's outline (the `legacy-static-text` case, drawn in
 * adl): a pixel of the screen, a BitmapData's in a draw, a texel of a 3D
 * object's bitmap.
 */
export const SNAP = 32;

/**
 * Which pixels a filtered layer's object covers (SceneList.wholes): those
 * of the target its drawing touches; or whole units, as Flash's bitmap of
 * an object is, antialiased those its edges touch and one more right and
 * down where an edge lies on one, aliased those whose centres it covers.
 */
export const NO_WHOLE = 0;
export const WHOLE_SMOOTH = 1;
export const WHOLE_ALIASED = 2;

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
  /** Each layer's rectangle of the target, in its pixels from the top left: x, y, width, height. */
  layers = new Int32Array(64);
  /**
   * Each layer's padding, as its filters reach past what is drawn: in the
   * target's units (its pixels over the resolution), or -1 for an
   * unfiltered layer, which covers what is drawn alone.
   */
  pads = new Int32Array(16);
  /**
   * Whether each filtered layer covers whole units of the target, as Flash
   * places the bitmap a ShaderFilter's kernel runs over, its coordinates
   * from its corner: NO_WHOLE, WHOLE_SMOOTH or WHOLE_ALIASED.
   */
  wholes = new Uint8Array(16);
  /** Each layer's kept output, which its output becomes (Keeps), or -1. */
  keeps = new Int32Array(16);
  /** The layer each layer is in, or -1. */
  parents = new Int32Array(16);
  /** The layers begun and not yet ended, innermost last. */
  private readonly open: number[] = [];
  /**
   * Each filtered layer's area as measured, before it was rounded and
   * padded: least x and y, greatest x and y, in target pixels.
   */
  areas = new Float64Array(64);
  layerCount = 0;

  reset(): void {
    this.length = 0;
    this.layerCount = 0;
    this.open.length = 0;
  }

  draw(geometry: number, row: number, blend: number, texture = -1, sampler = 0): void {
    this.push(DRAW, geometry, row, blend, texture, sampler);
  }

  /**
   * A layer begun, padded for its filters (or -1), over whole units as
   * `whole` says (wholes), its rectangle none till measured (layerRect):
   * its number.
   */
  layerBegin(padding = -1, keep = -1, whole = NO_WHOLE): number {
    const layer = this.newLayer(padding, keep);
    this.wholes[layer] = whole;
    this.push(LAYER_BEGIN, layer, 0, 0, -1, 0);
    this.open.push(layer);
    return layer;
  }

  /**
   * Kept output `keep` composited again over the rectangle x y width height
   * of the target, in blend mode `mode`, coloured by `row`.
   */
  keptLayer(
    keep: number,
    mode: number,
    row: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const layer = this.newLayer(-1, keep);
    this.layerRect(layer, x, y, width, height);
    this.push(KEPT, layer, row, mode, keep, 0);
  }

  private newLayer(padding: number, keep: number): number {
    const layer = this.layerCount++;
    if (layer >= this.pads.length) {
      this.layers = grow(this.layers);
      this.pads = grow(this.pads);
      this.wholes = grow(this.wholes);
      this.keeps = grow(this.keeps);
      this.parents = grow(this.parents);
      const areas = new Float64Array(this.areas.length * 2);
      areas.set(this.areas);
      this.areas = areas;
    }

    this.pads[layer] = padding;
    this.wholes[layer] = NO_WHOLE;
    this.keeps[layer] = keep;
    this.parents[layer] = this.open.at(-1) ?? -1;
    this.layerRect(layer, 0, 0, 0, 0);
    return layer;
  }

  /** Filtered layer `layer` padded by `padding` after all, as its filters were fitted once it was drawn. */
  padLayer(layer: number, padding: number): void {
    this.pads[layer] = padding;
  }

  /** The layer begun last ended: filtered by `chain` (or -1), composited in `mode`, coloured by `row`. */
  layerEnd(mode: number, row: number, chain = -1): void {
    this.open.pop();
    this.push(LAYER_END, mode, row, 0, chain, 0);
  }

  /**
   * Layer `layer` covers the rectangle x y width height of the target, in
   * its pixels from the top left; one of no size shows nothing.
   */
  layerRect(layer: number, x: number, y: number, width: number, height: number): void {
    const r = this.layers;
    r[layer * 4] = x;
    r[layer * 4 + 1] = y;
    r[layer * 4 + 2] = width;
    r[layer * 4 + 3] = height;
  }

  /**
   * A mask's marker, with two numbers in its geometry and row: MASK_USE
   * and MASK_POP name the mask's draws, from the first, so many of them.
   */
  marker(kind: number, a = 0, b = 0): void {
    this.push(kind, a, b, 0, -1, 0);
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
