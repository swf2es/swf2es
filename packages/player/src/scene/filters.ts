// A display object's filters as the renderer's passes (@swf2es/render's
// filters.ts), worked out to match adl: each one's values in the target's
// units, how far it pads past the object, cut where the padding would not
// fit a texture, and how far in the object's pixels start for those that
// read them. The rules they share with BitmapData.applyFilter are in
// display/filters.ts and bitmap/filters.ts.
import {
  BEVEL,
  BLUR,
  COLOR_MATRIX,
  CONVOLUTION,
  DISPLACEMENT,
  GLOW,
  GRADIENT,
  type TextureHandle,
} from "@swf2es/render";
import { type BitmapStore, rgbaOf } from "../bitmap/bitmap.js";
import {
  channelWeights,
  displacementAlpha,
  displacementGrowth,
  filterGrowth,
  gradientTable,
  integerKernel,
  paddedDistance,
} from "../bitmap/filters.js";
import { emptyKernel, type Filter as FilterRecord, filterOffset } from "../display/filters.js";

/**
 * A filter as the renderer runs it: its kind and values, a gradient's
 * colours with their texture, and a displacement's map, whose texture the
 * view keeps as it keeps a bitmap's.
 */
export interface Pass {
  kind: number;
  values: Float32Array;
  colors: Uint8Array | null;
  texture: TextureHandle | null;
  map: BitmapStore | null;
}

/**
 * A display object's filters worked out: their passes, how far they pad
 * the object altogether, and each one's padding as its reach asks, before
 * a cap (paddingCap) cuts it.
 */
export interface FilterPlan {
  passes: Pass[];
  padding: number;
  wanted: number[];
}

/**
 * A filter on its way to a pass: its kind, the padding its reach asks
 * for, then what it is cut to, and whether it reads the object's own
 * pixels, which then start `inset` in from its input's corner.
 */
interface Planned {
  record: FilterRecord;
  kind: number;
  wanted: number;
  padding: number;
  inset: number;
}

/**
 * The passes of `records` at `units` of the target to a stage pixel, none
 * padding past `cap`: null where none is drawn, as a displacement map is
 * not yet. A gradient's texture is kept from `previous` where its colours
 * are the same, as a tween of a gradient filter's blur writes them again.
 */
export function planFilters(
  records: readonly FilterRecord[],
  units: number,
  cap = Number.POSITIVE_INFINITY,
  previous: FilterPlan | null = null,
): FilterPlan | null {
  const planned: Planned[] = [];
  for (const record of records) {
    const kind = kindOf(record);
    // A displacement whose map is gone leaves the object be.
    if (kind === DISPLACEMENT && !mapOf(record)) {
      continue;
    }

    if (kind > 0) {
      const wanted = paddingOf(kind, record, units);
      planned.push({ record, kind, wanted, padding: Math.min(wanted, cap), inset: 0 });
    }
  }

  if (planned.length === 0) {
    return null;
  }

  let inset = 0;
  for (let i = planned.length - 1; i >= 0; i--) {
    inset += planned[i].padding;
    planned[i].inset = inset;
  }

  const passes = planned.map((p) => passOf(p, units));
  for (const pass of passes) {
    pass.texture = pass.colors ? sameColors(pass.colors, previous) : null;
  }

  return { passes, padding: inset, wanted: planned.map((p) => p.wanted) };
}

/** The texture of a gradient of `previous`'s with the same colours, if any. */
function sameColors(colors: Uint8Array, previous: FilterPlan | null): TextureHandle | null {
  for (const pass of previous?.passes ?? []) {
    const known = pass.colors;
    if (
      known &&
      pass.texture &&
      known.length === colors.length &&
      known.every((c, i) => c === colors[i])
    ) {
      return pass.texture;
    }
  }

  return null;
}

function kindOf(f: FilterRecord): number {
  switch (f.kind) {
    case "blur":
      return BLUR;
    case "glow":
    case "dropShadow":
      return GLOW;
    case "bevel":
      return BEVEL;
    case "gradientGlow":
    case "gradientBevel":
      return GRADIENT;
    case "colorMatrix":
      return COLOR_MATRIX;
    case "convolution":
      return CONVOLUTION;
    case "displacementMap":
      return DISPLACEMENT;
    default:
      return 0;
  }
}

/**
 * A displacement's map, the copy the object took when its filters were
 * set, or the live one where none was taken; null where it is gone.
 */
function mapOf(f: FilterRecord): BitmapStore | null {
  const map = (f.mapSnapshot ?? f.mapBitmap) as { $store?: BitmapStore } | null;
  const store = map?.$store ?? null;
  return store && !store.disposed && store.width > 0 && store.height > 0 ? store : null;
}

/** Whether `records` holds a filter the renderer does not draw yet. */
export function undrawnFilter(records: readonly FilterRecord[]): boolean {
  for (const f of records) {
    if (kindOf(f) === 0) {
      return true;
    }
  }

  return false;
}

/**
 * How far a filter pads past the object, in the target's units: its reach
 * in stage pixels, the blur's passes and the distance it is cast, at
 * `units` a stage pixel and in whole units; a convolution's its taps' and
 * the pixel right and down adl's bitmap of the object has; a colour
 * matrix none. A reach that is no number pads nothing.
 */
function paddingOf(kind: number, f: FilterRecord, units: number): number {
  const blur = (f.quality * Math.max(f.blurX, f.blurY)) / 2;
  let reach: number;
  switch (kind) {
    case BLUR:
      reach = blur;
      break;
    case GLOW:
      reach = blur + Math.abs(paddedDistance(f.kind === "dropShadow" ? f.distance || 0 : 0));
      break;
    case BEVEL:
      reach = blur + Math.abs(paddedDistance(f.distance || 0));
      break;
    case GRADIENT:
      reach = Math.max(...filterGrowth(f)) + 1;
      break;
    case CONVOLUTION:
      return Math.max(f.matrixX >> 1, f.matrixY >> 1) + 1;
    case DISPLACEMENT:
      // Its colour mode's fill round the object, and the pixel right and down adl's bitmap has.
      return Math.max(...displacementGrowth(f)) + 1;
    default:
      return 0;
  }

  const padding = Math.ceil(reach * units);
  return Number.isNaN(padding) ? 0 : padding;
}

/** A filter's values, in the order its kind lists them (@swf2es/render's filters.ts). */
function passOf(p: Planned, units: number): Pass {
  const f = p.record;
  const pass: Pass = {
    kind: p.kind,
    values: new Float32Array(0),
    colors: null,
    texture: null,
    map: null,
  };
  const blur = [f.blurX || 0, f.blurY || 0, f.quality, units];
  switch (p.kind) {
    case BLUR:
      pass.values = Float32Array.from(blur);
      break;
    case GLOW: {
      const shadow = f.kind === "dropShadow";
      const [ox, oy] = offsetOf(f, shadow ? f.distance || 0 : 0, units);
      pass.values = Float32Array.from([
        ...blur,
        ...rgb(f.color),
        f.alpha,
        f.strength,
        ox,
        oy,
        f.inner ? 1 : 0,
        f.knockout ? 1 : 0,
        shadow && f.hideObject ? 1 : 0,
      ]);
      break;
    }

    case BEVEL: {
      const [ox, oy] = offsetOf(f, f.distance || 0, units);
      pass.values = Float32Array.from([
        ...blur,
        ...rgb(f.highlightColor),
        ...rgb(f.shadowColor),
        f.highlightAlpha,
        f.shadowAlpha,
        f.strength,
        ox,
        oy,
        typeOf(f),
        f.knockout ? 1 : 0,
      ]);
      break;
    }

    case GRADIENT: {
      const [ox, oy] = offsetOf(f, f.distance || 0, units);
      pass.values = Float32Array.from([
        ...blur,
        f.strength,
        ox,
        oy,
        typeOf(f),
        f.knockout ? 1 : 0,
        f.kind === "gradientBevel" ? 1 : 0,
        p.inset,
        ...filterGrowth(f),
      ]);
      pass.colors = rgbaOf(gradientTable(f));
      break;
    }

    case COLOR_MATRIX: {
      // Column-major for GLSL: column j is input channel j's part of each output.
      const values = new Float32Array(20);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          values[col * 4 + row] = f.matrix[row * 5 + col] || 0;
        }

        values[16 + row] = (f.matrix[row * 5 + 4] || 0) / 255;
      }

      pass.values = values;
      break;
    }

    case CONVOLUTION: {
      const k = f.matrixX * f.matrixY > 0 ? f : emptyKernel(f);
      const count = k.matrixX * k.matrixY;
      const matrix = Array.from({ length: count }, (_, i) => k.matrix[i] || 0);
      const divisor = k.divisor || 1;
      const reciprocal = integerKernel(matrix, divisor);
      pass.values = Float32Array.from([
        k.matrixX,
        k.matrixY,
        (k.color >> 16) & 0xff,
        (k.color >> 8) & 0xff,
        k.color & 0xff,
        Math.floor(k.alpha * 255),
        divisor,
        reciprocal === null ? 0 : reciprocal / 65536,
        k.bias || 0,
        k.clamp ? 1 : 0,
        k.preserveAlpha ? 1 : 0,
        p.inset,
        ...matrix,
      ]);
      break;
    }

    case DISPLACEMENT: {
      const map = mapOf(f) as BitmapStore;
      const alpha = displacementAlpha(f);
      pass.values = Float32Array.from([
        ...channelWeights(f.componentX),
        ...channelWeights(f.componentY),
        f.scaleX || 0,
        f.scaleY || 0,
        ["wrap", "clamp", "ignore", "color"].indexOf(f.mode),
        ...rgb(f.color).map((c) => c * alpha),
        alpha,
        ...displacementGrowth(f),
        p.inset,
        f.mapPoint[0],
        f.mapPoint[1],
        map.width,
        map.height,
      ]);
      pass.map = map;
      break;
    }
  }

  return pass;
}

function rgb(color: number): number[] {
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
}

/** A bevel's or a gradient filter's type: inner 0, outer 1, full 2. */
function typeOf(f: FilterRecord): number {
  switch (f.type) {
    case "inner":
      return 0;
    case "outer":
      return 1;
    default:
      return 2;
  }
}

/** A filter's offset, `distance` stage pixels at its angle, in the target's units. */
function offsetOf(f: FilterRecord, distance: number, units: number): [number, number] {
  const offset: [number, number] = [0, 0];
  filterOffset(offset, f, distance, units);
  return offset;
}
