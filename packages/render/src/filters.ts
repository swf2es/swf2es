// Flash's filters as passes a layer takes before it is composited: what
// each kind reads, as the floats a frame's filter list holds for it, and
// the rules its passes keep to match adl (docs/architecture.md,
// "Filters"), which the backend's runner (webgl/filters.ts) and the Pixi
// view's filters share. Offsets and insets are in the target's units, its
// pixels over the resolution, as the shaders read their input's size in.

/** A blur: blurX, blurY, quality, units (the target's units a stage pixel). */
export const BLUR = 1;
/**
 * A glow or a drop shadow: blurX, blurY, quality, units; its colour's red,
 * green and blue from 0 to 1, alpha, strength; the offset x and y it is
 * cast by; inner, knockout and hide object, 1 or 0.
 */
export const GLOW = 2;
/**
 * A bevel: blurX, blurY, quality, units; the highlight's red, green and
 * blue, the shadow's, the highlight's alpha, the shadow's, strength; the
 * offset x and y; its type (0 inner, 1 outer, 2 full), knockout.
 */
export const BEVEL = 3;
/**
 * A gradient glow or bevel, its texture the gradient's 256 colours: blurX,
 * blurY, quality, units, strength; the offset x and y; type, knockout,
 * bevel (1, else a glow); how far in the object's pixels start; how far
 * its rect grows past them in stage pixels, left, top, right and bottom.
 */
export const GRADIENT = 4;
/** A colour matrix: its 4 by 4 part by columns, then its offsets over 255. */
export const COLOR_MATRIX = 5;
/**
 * A convolution: its columns and rows; the edge colour's red, green, blue
 * and alpha in 255ths; divisor, the fixed-point reciprocal over 65536 (0
 * for none), bias, clamp, preserve alpha; how far in the object's pixels
 * start; then the matrix by rows.
 */
export const CONVOLUTION = 6;

/**
 * A frame's filters in chains, one a filtered layer: each filter its kind,
 * its values and the texture it reads (-1 for none), written in order and
 * closed into a chain the layer's end names.
 */
export class Filters {
  kind = new Uint8Array(64);
  texture = new Int32Array(64);
  /** Where each filter's values start in `values`, and where the next one's do. */
  start = new Int32Array(65);
  values = new Float32Array(1024);
  count = 0;
  /** Where each chain's filters start, and where the next one's do: the first's, 0. */
  chains = new Int32Array(17);
  chainCount = 0;

  reset(): void {
    this.count = 0;
    this.chainCount = 0;
  }

  /** A filter of `kind` added to the chain open: its values, and the texture it reads. */
  add(kind: number, values: ArrayLike<number>, texture = -1): void {
    const at = this.count++;
    if (this.count >= this.kind.length) {
      this.kind = grow(this.kind);
      this.texture = grow(this.texture);
      this.start = grow(this.start);
    }

    const from = at > 0 ? this.start[at] : 0;
    if (from + values.length > this.values.length) {
      const grown = new Float32Array(Math.max(this.values.length * 2, from + values.length));
      grown.set(this.values);
      this.values = grown;
    }

    this.kind[at] = kind;
    this.texture[at] = texture;
    this.start[at] = from;
    this.values.set(values, from);
    this.start[at + 1] = from + values.length;
  }

  /** The filters added since the last chain closed, as a chain: its number. */
  close(): number {
    const chain = this.chainCount++;
    if (this.chainCount >= this.chains.length) {
      this.chains = grow(this.chains);
    }

    this.chains[chain + 1] = this.count;
    return chain;
  }
}

function grow<T extends Int32Array | Uint8Array>(array: T): T {
  const grown = new (array.constructor as new (length: number) => T)(array.length * 2);
  grown.set(array);
  return grown;
}

/**
 * The fewest texels a shrunk run spans, for each time a glow's strength
 * multiplies its alpha. Under it the bound below fails: an edge's ramp a
 * few coarse texels long bends sharply where a box ends, and drawn back
 * linearly between them a glow 8 wide at strength 2.37 shrunk three times
 * was off by 10 levels; a glow's strength multiplies that too.
 */
const SHRUNK_TEXELS = 8;

/** The most, in 255ths of alpha times strength, that drawing a shrunk blur back may be off by. */
const SHRUNK_ERROR = 2;

/**
 * The strongest glow or shadow a shrunk blur serves. Each run truncates to
 * a 255th, and drawn back between coarser texels a level's step moves by up
 * to a texel: off by a level the strength multiplies, however wide the blur.
 */
const SHRUNK_STRENGTH = 3;

/**
 * How many times coarser than its input a blur's runs one way may go: none
 * at a texel a stage pixel or under, nor where it does not blur that way;
 * otherwise whole times, to a texel a stage pixel at most, the run still
 * SHRUNK_TEXELS wide for each time strength multiplies it. A run reads a
 * texel for each of its width, so at three texels a stage pixel a glow 68
 * wide read 204 for each texel of an area nine times the stage's; shrunk
 * three times each way, it reads 68 for each of the stage's. Drawn back
 * between the coarser texels, what it blurred is off where it bends: at the
 * ends of a single box's ramp by a quarter of a coarse texel's rise, and
 * where two boxes or more bend smoothly by a sixth of the coarse texel
 * squared over the box's width squared; times the strength a glow multiplies
 * its alpha by, that stays within SHRUNK_ERROR. Each way is its own: a
 * streak 68 wide and 5 high goes coarser across alone.
 */
export function blurShrink(
  blur: number,
  quality: number,
  strength: number,
  texels: number,
): number {
  if (!(blur > 1 && quality > 0) || strength > SHRUNK_STRENGTH) {
    return 1;
  }

  const box = blur * texels;
  const amplified = 255 * Math.max(1, strength);
  const error =
    quality === 1
      ? (4 * SHRUNK_ERROR * box) / amplified
      : box * Math.sqrt((6 * SHRUNK_ERROR) / amplified);
  const most = Math.min(
    16,
    Math.floor(texels + 1e-6),
    Math.floor(box / (SHRUNK_TEXELS * Math.max(1, strength))),
  );
  return Math.max(1, Math.min(most, Math.floor(error)));
}
