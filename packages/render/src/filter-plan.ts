// A filtered layer's chain of Flash's filters as passes planned ahead of the
// GPU: for each pass, its program, the targets it reads and draws into, by
// slot, their frames, and its uniforms' values, as the backend's runner
// (webgl/filters.ts) draws them. Pure, so that a frame's chains can be
// planned all at once and their passes run in any order their slots allow.
import {
  BEVEL,
  BLUR,
  blurShrink,
  COLOR_MATRIX,
  CONVOLUTION,
  DISPLACEMENT,
  type Filters,
  GLOW,
  GRADIENT,
} from "./filters.js";

/** The passes' programs, each a fragment shader of filter-shaders.ts. */
export const BOX_PASS = 1;
export const SHRINK_PASS = 2;
export const READ_BACK_PASS = 3;
export const GLOW_PASS = 4;
export const BEVEL_PASS = 5;
export const GRADIENT_PASS = 6;
export const MATRIX_PASS = 7;
export const CONVOLUTION_PASS = 8;
export const DISPLACE_PASS = 9;

/** How a uniform's values are set: one to four floats, an array of vec4s, or a 4 by 4 matrix. */
export const FLOATS = 1;
export const VEC4S = 2;
export const MATRIX4 = 3;

/** A pass's blurred input (FilterPass.blurred): none read, or the pass's input itself. */
export const NO_BLUR = -2;
export const INPUT_BLUR = -1;

/** The most floats a convolution's matrix takes in its shader: 57 vec4s. */
export const CONVOLUTION_FLOATS = 57 * 4;

/** One pass: a program drawn from slot `input` into slot `output`, its uniforms in its plan's. */
export interface FilterPass {
  program: number;
  input: number;
  /** The input's texels read, from its corner: its frame, or more of it for a shrink. */
  readWidth: number;
  readHeight: number;
  output: number;
  width: number;
  height: number;
  /** The slot read as the blur (NO_BLUR, INPUT_BLUR), and how much coarser it is each way. */
  blurred: number;
  across: number;
  down: number;
  /** A texture of the frame's it reads, a gradient's colours or a map, or -1. */
  texture: number;
  /** Its uniforms in the plan's (uniformName and the rest), from `first` to before `end`. */
  first: number;
  end: number;
}

/**
 * A chain's passes, its targets by slot, each a frame of a width and
 * height, slot 0 the layer it runs on, and the slot its output is left
 * in. Kept from chain to chain, its records reused.
 */
export class FilterPlan {
  readonly passes: FilterPass[] = [];
  count = 0;
  readonly slotWidth: number[] = [];
  readonly slotHeight: number[] = [];
  slots = 0;
  result = 0;
  /** The target's pixels a unit of its own, which the shaders read their input's size in. */
  resolution = 1;
  /** The uniforms: each one's name, how it is set, where its values start and how many. */
  readonly uniformName: string[] = [];
  readonly uniformKind: number[] = [];
  readonly uniformAt: number[] = [];
  readonly uniformCount: number[] = [];
  uniforms = 0;
  values = new Float32Array(1024);
  valueCount = 0;

  /** Empty, for a chain run at `resolution` on a layer of `width` by `height`. */
  reset(width: number, height: number, resolution: number): void {
    this.count = 0;
    this.slots = 0;
    this.uniforms = 0;
    this.valueCount = 0;
    this.resolution = resolution;
    this.result = this.slot(width, height);
  }

  /** A new slot, a target of `width` by `height`. */
  slot(width: number, height: number): number {
    this.slotWidth[this.slots] = width;
    this.slotHeight[this.slots] = height;
    return this.slots++;
  }

  /** A pass begun, its uniforms the ones set after it until the next. */
  pass(
    program: number,
    input: number,
    readWidth: number,
    readHeight: number,
    output: number,
    width: number,
    height: number,
  ): FilterPass {
    let pass = this.passes[this.count];
    if (!pass) {
      pass = {
        program: 0,
        input: 0,
        readWidth: 0,
        readHeight: 0,
        output: 0,
        width: 0,
        height: 0,
        blurred: NO_BLUR,
        across: 1,
        down: 1,
        texture: -1,
        first: 0,
        end: 0,
      };
      this.passes[this.count] = pass;
    }

    this.count++;
    pass.program = program;
    pass.input = input;
    pass.readWidth = readWidth;
    pass.readHeight = readHeight;
    pass.output = output;
    pass.width = width;
    pass.height = height;
    pass.blurred = NO_BLUR;
    pass.across = 1;
    pass.down = 1;
    pass.texture = -1;
    pass.first = this.uniforms;
    pass.end = this.uniforms;
    return pass;
  }

  /** A uniform of `count` floats of the pass begun last, `x` and those after. */
  uniform(name: string, count: number, x: number, y = 0, z = 0, w = 0): void {
    const four = this.four;
    four[0] = x;
    four[1] = y;
    four[2] = z;
    four[3] = w;
    this.uniformFrom(name, FLOATS, four, 0, count);
  }

  /** uniform's values, passed on without an array of their own. */
  private readonly four = new Float64Array(4);

  /** A uniform of the pass begun last, set `kind` from `count` of `source` from `at`. */
  uniformFrom(name: string, kind: number, source: ArrayLike<number>, at: number, count: number) {
    const u = this.uniforms++;
    this.uniformName[u] = name;
    this.uniformKind[u] = kind;
    this.uniformAt[u] = this.valueCount;
    this.uniformCount[u] = count;
    if (this.valueCount + count > this.values.length) {
      const grown = new Float32Array(Math.max(this.values.length * 2, this.valueCount + count));
      grown.set(this.values);
      this.values = grown;
    }

    for (let k = 0; k < count; k++) {
      this.values[this.valueCount + k] = source[at + k];
    }

    this.valueCount += count;
    this.passes[this.count - 1].end = this.uniforms;
  }
}

/** What a blur made of a slot: the slot it is in, and how much coarser it is each way. */
interface Blurred {
  slot: number;
  across: number;
  down: number;
}

/**
 * Chain `chain` of `filters` planned into `plan` over a layer of `width` by
 * `height` texels at `resolution`, `hasTexture` telling which of the
 * frame's textures there are: a filter whose texture is not leaves its
 * input as it is, as one that changes nothing does.
 */
export function planChain(
  plan: FilterPlan,
  filters: Filters,
  chain: number,
  width: number,
  height: number,
  resolution: number,
  hasTexture: (id: number) => boolean,
): void {
  plan.reset(width, height, resolution);
  const end = filters.chains[chain + 1];
  for (let i = filters.chains[chain]; i < end; i++) {
    plan.result = planFilter(
      plan,
      filters.kind[i],
      filters.values,
      filters.start[i],
      filters.texture[i],
      plan.result,
      width,
      height,
      hasTexture,
    );
  }
}

/** One filter, its values from `v[at]`, over slot `input`: the slot it drew into, or `input`. */
function planFilter(
  plan: FilterPlan,
  kind: number,
  v: Float32Array,
  at: number,
  texture: number,
  input: number,
  width: number,
  height: number,
  hasTexture: (id: number) => boolean,
): number {
  switch (kind) {
    case BLUR:
      return blurFilter(plan, v, at, input, width, height);
    case GLOW:
      return glow(plan, v, at, input, width, height);
    case BEVEL:
      return bevel(plan, v, at, input, width, height);
    case GRADIENT:
      return hasTexture(texture) ? gradient(plan, v, at, texture, input, width, height) : input;
    case COLOR_MATRIX:
      return colorMatrix(plan, v, at, input, width, height);
    case CONVOLUTION:
      return convolution(plan, v, at, input, width, height);
    case DISPLACEMENT:
      return hasTexture(texture) ? displacement(plan, v, at, texture, input, width, height) : input;
    default:
      return input;
  }
}

/** A blur: the box's runs, done coarser and drawn back between their texels where that is close enough. */
function blurFilter(
  plan: FilterPlan,
  v: Float32Array,
  at: number,
  input: number,
  width: number,
  height: number,
): number {
  const blurX = v[at];
  const blurY = v[at + 1];
  const quality = v[at + 2];
  if (!(quality > 0 && (blurX > 1 || blurY > 1))) {
    return input;
  }

  const texels = plan.resolution * v[at + 3];
  const across = blurShrink(blurX, quality, 1, texels);
  const down = blurShrink(blurY, quality, 1, texels);
  if (across === 1 && down === 1) {
    const out = plan.slot(width, height);
    boxRuns(plan, input, width, height, out, blurX, blurY, quality, texels, texels);
    return out;
  }

  const blurred = blurredOf(
    plan,
    input,
    width,
    height,
    blurX,
    blurY,
    quality,
    texels,
    across,
    down,
  );
  const out = plan.slot(width, height);
  readBlurred(plan.pass(READ_BACK_PASS, input, width, height, out, width, height), blurred);
  return out;
}

/** A glow or a drop shadow: the input's alpha blurred, coarser where close enough, in its colour. */
function glow(
  plan: FilterPlan,
  v: Float32Array,
  at: number,
  input: number,
  width: number,
  height: number,
): number {
  const blurX = v[at];
  const blurY = v[at + 1];
  const quality = v[at + 2];
  const strength = v[at + 8];
  const texels = plan.resolution * v[at + 3];
  const across = blurShrink(blurX, quality, strength, texels);
  const down = blurShrink(blurY, quality, strength, texels);
  const blurred = blurredOf(
    plan,
    input,
    width,
    height,
    blurX,
    blurY,
    quality,
    texels,
    across,
    down,
  );
  const out = plan.slot(width, height);
  readBlurred(plan.pass(GLOW_PASS, input, width, height, out, width, height), blurred);
  plan.uniformFrom("uColor", FLOATS, v, at + 4, 3);
  plan.uniform("uAlpha", 1, v[at + 7]);
  plan.uniform("uStrength", 1, strength);
  plan.uniformFrom("uOffset", FLOATS, v, at + 9, 2);
  plan.uniform("uInner", 1, v[at + 11]);
  plan.uniform("uKnockout", 1, v[at + 12]);
  plan.uniform("uHide", 1, v[at + 13]);
  return out;
}

/** A bevel: the input's alpha blurred, read on and back by its offset. */
function bevel(
  plan: FilterPlan,
  v: Float32Array,
  at: number,
  input: number,
  width: number,
  height: number,
): number {
  const texels = plan.resolution * v[at + 3];
  const blurred = blurredOf(plan, input, width, height, v[at], v[at + 1], v[at + 2], texels, 1, 1);
  const out = plan.slot(width, height);
  readBlurred(plan.pass(BEVEL_PASS, input, width, height, out, width, height), blurred);
  plan.uniformFrom("uHighlight", FLOATS, v, at + 4, 3);
  plan.uniformFrom("uShadow", FLOATS, v, at + 7, 3);
  plan.uniform("uHighlightAlpha", 1, v[at + 10]);
  plan.uniform("uShadowAlpha", 1, v[at + 11]);
  plan.uniform("uStrength", 1, v[at + 12]);
  plan.uniformFrom("uOffset", FLOATS, v, at + 13, 2);
  plan.uniform("uType", 1, v[at + 15]);
  plan.uniform("uKnockout", 1, v[at + 16]);
  return out;
}

/** A gradient glow or bevel: the blurred alpha picking a colour of its gradient, texture `id`. */
function gradient(
  plan: FilterPlan,
  v: Float32Array,
  at: number,
  id: number,
  input: number,
  width: number,
  height: number,
): number {
  const units = v[at + 3];
  const texels = plan.resolution * units;
  const blurred = blurredOf(plan, input, width, height, v[at], v[at + 1], v[at + 2], texels, 1, 1);
  const out = plan.slot(width, height);
  const pass = plan.pass(GRADIENT_PASS, input, width, height, out, width, height);
  readBlurred(pass, blurred);
  pass.texture = id;
  plan.uniform("uStrength", 1, v[at + 4]);
  plan.uniformFrom("uOffset", FLOATS, v, at + 5, 2);
  plan.uniform("uType", 1, v[at + 7]);
  plan.uniform("uKnockout", 1, v[at + 8]);
  plan.uniform("uBevel", 1, v[at + 9]);
  const inset = v[at + 10];
  plan.uniform(
    "uRegion",
    4,
    inset - v[at + 11] * units,
    inset - v[at + 12] * units,
    width / plan.resolution - inset + units + v[at + 13] * units,
    height / plan.resolution - inset + units + v[at + 14] * units,
  );
  return out;
}

function colorMatrix(
  plan: FilterPlan,
  v: Float32Array,
  at: number,
  input: number,
  width: number,
  height: number,
): number {
  const out = plan.slot(width, height);
  plan.pass(MATRIX_PASS, input, width, height, out, width, height);
  plan.uniformFrom("uMatrix", MATRIX4, v, at, 16);
  plan.uniformFrom("uOffset", FLOATS, v, at + 16, 4);
  return out;
}

/** A convolution's weights, its matrix by rows padded to the shader's array. */
const weights = new Float32Array(CONVOLUTION_FLOATS);

function convolution(
  plan: FilterPlan,
  v: Float32Array,
  at: number,
  input: number,
  width: number,
  height: number,
): number {
  const columns = v[at];
  const rows = v[at + 1];
  weights.fill(0);
  weights.set(v.subarray(at + 12, at + 12 + Math.min(columns * rows, weights.length)));
  const out = plan.slot(width, height);
  plan.pass(CONVOLUTION_PASS, input, width, height, out, width, height);
  plan.uniformFrom("uMatrix", VEC4S, weights, 0, weights.length);
  plan.uniform("uSize", 2, columns, rows);
  plan.uniformFrom("uEdge", FLOATS, v, at + 2, 4);
  plan.uniform("uDivisor", 1, v[at + 6]);
  plan.uniform("uReciprocal", 1, v[at + 7]);
  plan.uniform("uBias", 1, v[at + 8]);
  plan.uniform("uClamp", 1, v[at + 9]);
  plan.uniform("uPreserve", 1, v[at + 10]);
  const inset = v[at + 11];
  plan.uniform(
    "uBox",
    4,
    inset,
    inset,
    width / plan.resolution - inset + 1,
    height / plan.resolution - inset + 1,
  );
  return out;
}

/** A displacement map: each of the object's pixels read from where its map, texture `id`, moves it. */
function displacement(
  plan: FilterPlan,
  v: Float32Array,
  at: number,
  id: number,
  input: number,
  width: number,
  height: number,
): number {
  const out = plan.slot(width, height);
  const pass = plan.pass(DISPLACE_PASS, input, width, height, out, width, height);
  pass.texture = id;
  plan.uniformFrom("uComponentX", FLOATS, v, at, 4);
  plan.uniformFrom("uComponentY", FLOATS, v, at + 4, 4);
  plan.uniformFrom("uScale", FLOATS, v, at + 8, 2);
  plan.uniform("uMode", 1, v[at + 10]);
  plan.uniformFrom("uColor", FLOATS, v, at + 11, 4);
  plan.uniformFrom("uGrow", FLOATS, v, at + 15, 2);
  const inset = v[at + 17];
  plan.uniform(
    "uBox",
    4,
    inset,
    inset,
    width / plan.resolution - inset + 1,
    height / plan.resolution - inset + 1,
  );
  plan.uniform("uMapAt", 4, inset + v[at + 18], inset + v[at + 19], v[at + 20], v[at + 21]);
  return out;
}

/** `pass` reading `blurred` as its blur, or its input where nothing blurred it. */
function readBlurred(pass: FilterPass, blurred: Blurred | null): void {
  pass.blurred = blurred ? blurred.slot : INPUT_BLUR;
  pass.across = blurred ? blurred.across : 1;
  pass.down = blurred ? blurred.down : 1;
}

/**
 * The box's runs over `input`'s frame into a new slot, `across` times
 * narrower and `down` times lower (blurShrink); null where no run would
 * change it.
 */
function blurredOf(
  plan: FilterPlan,
  input: number,
  width: number,
  height: number,
  blurX: number,
  blurY: number,
  quality: number,
  texels: number,
  across: number,
  down: number,
): Blurred | null {
  if (!(quality > 0 && (blurX > 1 || blurY > 1))) {
    return null;
  }

  let source = input;
  let w = width;
  let h = height;
  if (across > 1 || down > 1) {
    w = Math.ceil(width / across);
    h = Math.ceil(height / down);
    source = plan.slot(w, h);
    plan.pass(SHRINK_PASS, input, w * across, h * down, source, w, h);
    plan.uniform("uFactor", 2, across, down);
  }

  const out = plan.slot(w, h);
  boxRuns(plan, source, w, h, out, blurX, blurY, quality, texels / across, texels / down);
  blurredScratch.slot = out;
  blurredScratch.across = across;
  blurredScratch.down = down;
  return blurredScratch;
}

/** What blurredOf gives, read before it is asked again. */
const blurredScratch: Blurred = { slot: 0, across: 1, down: 1 };

/**
 * The box's runs over slot `input`'s frame into slot `output`'s, through
 * slots between them, the second only where a third run needs one:
 * `texelsX` and `texelsY` to a stage pixel each way, which the blur is in,
 * each step a texel of the input.
 */
function boxRuns(
  plan: FilterPlan,
  input: number,
  width: number,
  height: number,
  output: number,
  blurX: number,
  blurY: number,
  quality: number,
  texelsX: number,
  texelsY: number,
): void {
  const step = 1 / plan.resolution;
  const across = blurX > 1;
  const down = blurY > 1;
  const runs = quality * ((across ? 1 : 0) + (down ? 1 : 0));
  if (runs === 0) {
    plan.pass(BOX_PASS, input, width, height, output, width, height);
    plan.uniform("uDirection", 2, 1, 0);
    plan.uniform("uWidth", 1, 1);
    return;
  }

  const first = runs > 1 ? plan.slot(width, height) : -1;
  const second = runs > 2 ? plan.slot(width, height) : -1;
  let from = input;
  for (let k = 0; k < runs; k++) {
    const to = k === runs - 1 ? output : k % 2 === 0 ? first : second;
    plan.pass(BOX_PASS, from, width, height, to, width, height);
    if (across && (!down || k % 2 === 0)) {
      plan.uniform("uDirection", 2, step, 0);
      plan.uniform("uWidth", 1, blurX * texelsX);
    } else {
      plan.uniform("uDirection", 2, 0, step);
      plan.uniform("uWidth", 1, blurY * texelsY);
    }

    from = to;
  }
}
