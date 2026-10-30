// A display object's filters as records of their values, as adl keeps
// them: what flash.filters' objects read and set (playerglobal's
// flash/filters/, a file per class), what a PlaceObject3's list becomes,
// and what the renderer will draw. A record holds the keys of its kind alone.
import type { SwfFilter } from "@swf2es/format";
import type { ShaderUse } from "../bitmap/pixel-bender.js";

export type FilterKind =
  | "blur"
  | "glow"
  | "dropShadow"
  | "bevel"
  | "gradientGlow"
  | "gradientBevel"
  | "colorMatrix"
  | "convolution"
  | "displacementMap"
  | "shader";

/** Every value a filter may have; a kind's record has its own keys only. */
export interface Filter {
  kind: FilterKind;
  blurX: number;
  blurY: number;
  quality: number;
  alpha: number;
  color: number;
  strength: number;
  /** In degrees, within a turn either way. */
  angle: number;
  distance: number;
  inner: boolean;
  knockout: boolean;
  hideObject: boolean;
  highlightColor: number;
  highlightAlpha: number;
  shadowColor: number;
  shadowAlpha: number;
  type: string;
  colors: number[];
  alphas: number[];
  ratios: number[];
  matrix: number[];
  matrixX: number;
  matrixY: number;
  divisor: number;
  bias: number;
  clamp: boolean;
  preserveAlpha: boolean;
  /** The AS3 BitmapData a displacement map reads. */
  mapBitmap: object | null;
  /**
   * A display object's displacement map as it was when its filters were
   * set, which it draws with: a copy of `mapBitmap`, which stays the live
   * one that reading `filters` back gives. Null where not taken.
   */
  mapSnapshot?: object | null;
  mapPoint: [number, number];
  componentX: number;
  componentY: number;
  scaleX: number;
  scaleY: number;
  mode: string;
  /** A ShaderFilter's AS3 Shader. */
  shader: object | null;
  /** How far a ShaderFilter grows the object's bitmap, in stage pixels: left, top, right, bottom. */
  extensions: [number, number, number, number];
  /**
   * A display object's ShaderFilter's kernel as it was when its filters
   * were set, with its parameters and images then, which it draws with.
   */
  shaderUse?: ShaderUse | null;
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

/**
 * A kind's values as a new filter object of it has them in adl: made for
 * the kind alone, as a timeline that writes a filter on each frame asks
 * for one each time.
 */
export function filterDefaults(kind: FilterKind): Filter {
  return { kind, ...kindDefaults(kind) } as Filter;
}

function kindDefaults(kind: FilterKind): object {
  const shadow = () => ({
    angle: 45,
    blurX: 4,
    blurY: 4,
    distance: 4,
    knockout: false,
    quality: 1,
  });
  switch (kind) {
    case "blur":
      return { blurX: 4, blurY: 4, quality: 1 };
    case "glow":
      return {
        alpha: 1,
        blurX: 6,
        blurY: 6,
        color: 0xff0000,
        inner: false,
        knockout: false,
        quality: 1,
        strength: 2,
      };
    case "dropShadow":
      return {
        ...shadow(),
        alpha: 1,
        color: 0,
        hideObject: false,
        inner: false,
        strength: 1,
      };
    case "bevel":
      return {
        ...shadow(),
        highlightAlpha: 1,
        highlightColor: 0xffffff,
        shadowAlpha: 1,
        shadowColor: 0,
        strength: 1,
        type: "inner",
      };
    case "gradientGlow":
    case "gradientBevel":
      return { ...shadow(), strength: 1, type: "inner", colors: [], alphas: [], ratios: [] };
    case "colorMatrix":
      return { matrix: [...IDENTITY_MATRIX] };
    case "convolution":
      return {
        alpha: 0,
        bias: 0,
        clamp: true,
        color: 0,
        divisor: 1,
        matrix: [],
        matrixX: 0,
        matrixY: 0,
        preserveAlpha: true,
      };
    case "displacementMap":
      return {
        alpha: 0,
        color: 0,
        componentX: 0,
        componentY: 0,
        mapBitmap: null,
        mapPoint: [0, 0],
        mode: "wrap",
        scaleX: 0,
        scaleY: 0,
      };
    case "shader":
      return { shader: null, extensions: [0, 0, 0, 0] };
  }
}

/** A copy of a record, its lists its own. */
export function copyFilter(f: Filter): Filter {
  const copy = { ...f };
  for (const key of ["colors", "alphas", "ratios", "matrix", "mapPoint", "extensions"] as const) {
    if (key in f) {
      (copy as Record<string, unknown>)[key] = [...(f[key] as number[])];
    }
  }

  return copy;
}

const DEGREES = 180 / Math.PI;

/** A PlaceObject3 filter as the record its object reads back. */
export function filterOfSwf(f: SwfFilter): Filter {
  switch (f.type) {
    case "blur":
      return { ...filterDefaults("blur"), blurX: f.blurX, blurY: f.blurY, quality: f.passes };
    case "glow":
      return {
        ...filterDefaults("glow"),
        color: f.color.rgb,
        alpha: f.color.alpha / 255,
        blurX: f.blurX,
        blurY: f.blurY,
        strength: f.strength,
        inner: f.inner,
        knockout: f.knockout,
        quality: f.passes,
      };
    case "dropShadow":
      return {
        ...filterDefaults("dropShadow"),
        color: f.color.rgb,
        alpha: f.color.alpha / 255,
        blurX: f.blurX,
        blurY: f.blurY,
        angle: f.angle * DEGREES,
        distance: f.distance,
        strength: f.strength,
        inner: f.inner,
        knockout: f.knockout,
        hideObject: !f.composite,
        quality: f.passes,
      };
    case "bevel":
    case "gradientGlow":
    case "gradientBevel": {
      const shared = {
        blurX: f.blurX,
        blurY: f.blurY,
        angle: f.angle * DEGREES,
        distance: f.distance,
        strength: f.strength,
        knockout: f.knockout,
        quality: f.passes,
        type: f.inner ? "inner" : f.onTop ? "full" : "outer",
      };
      if (f.type === "bevel") {
        const [shadow, highlight] = f.colors;
        return {
          ...filterDefaults("bevel"),
          ...shared,
          shadowColor: shadow.rgb,
          shadowAlpha: shadow.alpha / 255,
          highlightColor: highlight.rgb,
          highlightAlpha: highlight.alpha / 255,
        };
      }

      return {
        ...filterDefaults(f.type),
        ...shared,
        colors: f.colors.map((c) => c.rgb),
        alphas: f.colors.map((c) => c.alpha / 255),
        ratios: [...f.ratios],
      };
    }
    case "convolution":
      return {
        ...filterDefaults("convolution"),
        matrixX: f.matrixX,
        matrixY: f.matrixY,
        divisor: f.divisor,
        bias: f.bias,
        matrix: [...f.matrix],
        color: f.color.rgb,
        alpha: f.color.alpha / 255,
        clamp: f.clamp,
        preserveAlpha: f.preserveAlpha,
      };
    case "colorMatrix":
      return { ...filterDefaults("colorMatrix"), matrix: [...f.matrix] };
  }
}

/**
 * Whether two lists of filter records hold the same values, which draw the
 * same: a timeline's tween writes its filters again on each frame, and a
 * script may set them from their own. A map is the same only as the same
 * object, so that a displacement's map taken anew is drawn anew.
 */
export function sameFilterRecords(a: readonly Filter[], b: readonly Filter[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  // Compared each frame for every object a tween filters, so without allocating.
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as unknown as Record<string, unknown>;
    const y = b[i] as unknown as Record<string, unknown>;
    let keys = 0;
    for (const key in x) {
      keys++;
      if (!(key in y) || !sameValue(x[key], y[key])) {
        return false;
      }
    }

    for (const _ in y) {
      keys--;
    }

    if (keys !== 0) {
      return false;
    }
  }

  return true;
}

function sameValue(u: unknown, v: unknown): boolean {
  if (!Array.isArray(u) || !Array.isArray(v)) {
    return Object.is(u, v);
  }

  if (u.length !== v.length) {
    return false;
  }

  for (let k = 0; k < u.length; k++) {
    if (!Object.is(u[k], v[k])) {
      return false;
    }
  }

  return true;
}

/**
 * A convolution with no taps as adl draws it, a copy moved up and left by
 * the half of the other size: one tap there, of 1, the edges transparent.
 */
export function emptyKernel(f: Filter): Filter {
  const hx = f.matrixX >> 1;
  const hy = f.matrixY >> 1;
  const matrixX = 2 * hx + 1;
  const matrixY = 2 * hy + 1;
  const matrix = new Array(matrixX * matrixY).fill(0);
  matrix[matrix.length - 1] = 1;
  return {
    ...f,
    matrixX,
    matrixY,
    matrix,
    divisor: 1,
    bias: 0,
    clamp: false,
    color: 0,
    alpha: 0,
    preserveAlpha: false,
  };
}

/** A filter's offset into `out`, `distance` stage pixels at its angle, in `units` a stage pixel. */
export function filterOffset(
  out: { [i: number]: number },
  f: Filter,
  distance: number,
  units: number,
): void {
  const radians = ((f.angle || 0) * Math.PI) / 180;
  out[0] = distance * Math.cos(radians) * units;
  out[1] = distance * Math.sin(radians) * units;
}

/**
 * How far either side of a display object its filters may pad, in the
 * target's units: what a texture `limit` texels a side holds at
 * `resolution` texels a unit, past the object's area on the target
 * (`width` by `height` units, cut to it) and a little.
 */
export function filterRoom(
  limit: number,
  resolution: number,
  width: number,
  height: number,
): number {
  return Math.floor((limit / resolution - Math.max(width, height, 0)) / 2) - 2;
}

/**
 * The most any one filter pads, where their paddings as their reach asks
 * (`wanted`) together pass `room`: cut alike from the furthest reaching
 * down to what fits, as a shadow cast 1e9 away, or Infinity, asks;
 * Infinity where they fit. What is cut lies past the screen, but for an
 * object off it whose shadow is not.
 */
export function paddingCap(wanted: readonly number[], room: number): number {
  let total = 0;
  for (const p of wanted) {
    total += p;
  }

  if (total <= room) {
    return Number.POSITIVE_INFINITY;
  }

  const sorted = [...wanted].sort((a, b) => a - b);
  let below = 0;
  for (let i = 0; i < sorted.length; i++) {
    const level = Math.floor((Math.max(0, room) - below) / (sorted.length - i));
    if (level <= sorted[i]) {
      return Math.max(0, level);
    }

    below += sorted[i];
  }

  return 0;
}
