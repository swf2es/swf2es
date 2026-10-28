// A display object's filters as the renderer's passes (@swf2es/render's
// filters.ts), worked out as the Pixi view's filters work them
// (render/filters.ts), which match adl: each one's values in the target's
// units, how far it pads past the object, cut where the padding would not
// fit a texture, and how far in the object's pixels start for those that
// read them.
import {
  BEVEL,
  BLUR,
  COLOR_MATRIX,
  CONVOLUTION,
  GLOW,
  GRADIENT,
  type TextureHandle,
} from "@swf2es/render";
import { rgbaOf } from "../bitmap/bitmap.js";
import { filterRect, gradientTable, integerKernel } from "../bitmap/filters.js";
import { emptyKernel, type Filter as FilterRecord } from "../display/filters.js";

/** A filter as the renderer runs it: its kind and values, and a gradient's colours with their texture. */
export interface Pass {
  kind: number;
  values: Float32Array;
  colors: Uint8Array | null;
  texture: TextureHandle | null;
}

/** A display object's filters worked out: their passes, and how far they pad the object altogether. */
export interface FilterPlan {
  passes: Pass[];
  padding: number;
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
 * The passes of `records` at `units` of the target to a stage pixel,
 * padded at most so far as fits `room` either side of the object: null
 * where none is drawn, as a displacement map is not yet.
 */
export function planFilters(
  records: readonly FilterRecord[],
  units: number,
  room: number,
): FilterPlan | null {
  const planned: Planned[] = [];
  for (const record of records) {
    const kind = kindOf(record);
    if (kind > 0) {
      const wanted = paddingOf(kind, record, units);
      planned.push({ record, kind, wanted, padding: wanted, inset: 0 });
    }
  }

  if (planned.length === 0) {
    return null;
  }

  fitPadding(planned, room);
  let inset = 0;
  for (let i = planned.length - 1; i >= 0; i--) {
    inset += planned[i].padding;
    planned[i].inset = inset;
  }

  let padding = 0;
  for (const p of planned) {
    padding += p.padding;
  }

  return { passes: planned.map((p) => passOf(p, units)), padding };
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
    default:
      return 0;
  }
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
      reach = Math.max(...grows(f)) + 1;
      break;
    case CONVOLUTION:
      return Math.max(f.matrixX >> 1, f.matrixY >> 1) + 1;
    default:
      return 0;
  }

  const padding = Math.ceil(reach * units);
  return Number.isNaN(padding) ? 0 : padding;
}

/**
 * A distance as far as it pads: NaN none; Infinity, or the -8388866
 * generateFilterRect makes of NaN, as far as a GPU's texture could be,
 * which fitPadding cuts to what this one can draw.
 */
function paddedDistance(distance: number): number {
  return Number.isNaN(distance) ? 0 : Math.max(-(2 ** 24), Math.min(2 ** 24, distance));
}

/** How far a gradient filter's rect grows past the object in stage pixels: left, top, right, bottom. */
function grows(f: FilterRecord): number[] {
  const rect = filterRect(
    { x: 0, y: 0, width: 1, height: 1 },
    { ...f, distance: paddedDistance(f.distance) },
  );
  return [-rect.x, -rect.y, rect.x + rect.width - 1, rect.y + rect.height - 1];
}

/**
 * The filters' padding as their reach asks, where it fits `room` either
 * side of the object; past that, cut alike from the furthest reaching
 * down to what fits, as a shadow cast 1e9 away, or Infinity, asks.
 */
function fitPadding(planned: Planned[], room: number): void {
  let total = 0;
  for (const p of planned) {
    total += p.wanted;
  }

  if (total <= room) {
    return;
  }

  const sorted = planned.map((p) => p.wanted).sort((a, b) => a - b);
  let below = 0;
  let cap = 0;
  for (let i = 0; i < sorted.length; i++) {
    const level = Math.floor((Math.max(0, room) - below) / (sorted.length - i));
    if (level <= sorted[i]) {
      cap = Math.max(0, level);
      break;
    }

    below += sorted[i];
  }

  for (const p of planned) {
    p.padding = Math.min(p.wanted, cap);
  }
}

/** A filter's values, in the order its kind lists them (@swf2es/render's filters.ts). */
function passOf(p: Planned, units: number): Pass {
  const f = p.record;
  const pass: Pass = { kind: p.kind, values: new Float32Array(0), colors: null, texture: null };
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
        ...grows(f),
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
  const radians = ((f.angle || 0) * Math.PI) / 180;
  return [distance * Math.cos(radians) * units, distance * Math.sin(radians) * units];
}
