// flash.filters.BitmapFilter, and what its subclasses share: each keeps its
// values as adl converts them, in a record (`$filter`) that
// DisplayObject.filters copies to and from the display object's
// (display/filters.ts in the player), so a filter read back is a copy.
import { avm2 } from "@swf2es/runtime";
import { type Filter, type FilterKind, filterDefaults } from "../../../display/filters.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export type Prop = [get: (f: Filter) => Value, set: (f: Filter, v: Value) => void];

const CLASSES: [string, FilterKind][] = [
  ["BlurFilter", "blur"],
  ["GlowFilter", "glow"],
  ["DropShadowFilter", "dropShadow"],
  ["BevelFilter", "bevel"],
  ["GradientGlowFilter", "gradientGlow"],
  ["GradientBevelFilter", "gradientBevel"],
  ["ColorMatrixFilter", "colorMatrix"],
  ["ConvolutionFilter", "convolution"],
  ["DisplacementMapFilter", "displacementMap"],
];

/** A filter object's class by kind, for the objects a display object's filters are read back as. */
export function filterClassName(kind: FilterKind): string {
  return `flash.filters::${CLASSES.find(([, k]) => k === kind)?.[0]}`;
}

/** The kind of a filter object, by its class or a base of it: null for one that is no filter swf2es knows. */
export function filterKindOf(rt: avm2.Runtime, o: AsObject): FilterKind | null {
  for (let t: ReturnType<avm2.Runtime["traitsOf"]> | null = rt.traitsOf(o); t; t = t.base) {
    const found = CLASSES.find(([name]) => t.name === `flash.filters::${name}`);
    if (found) {
      return found[1];
    }
  }

  return null;
}

/** The record of a filter object, made with the kind's defaults when first touched. */
export function recordOf(o: AsObject, kind: FilterKind): Filter {
  o.$filter ??= filterDefaults(kind);
  return o.$filter;
}

/** The conversions of filters' values as adl keeps them: alpha in 255ths, strength in 256ths, clamped. */
function filterValues(s: Scripting) {
  const num = (v: Value) => s.rt.toNumber(v);
  const blur = (v: Value) => {
    const n = num(v);
    return Number.isNaN(n) ? n : Math.max(0, Math.min(255, n));
  };
  const quality = (v: Value) => Math.max(0, Math.min(15, s.rt.toInt(v)));
  const alpha = (v: Value) => {
    const n = num(v);
    return Number.isNaN(n) ? 0 : Math.trunc(Math.max(0, Math.min(1, n)) * 255) / 255;
  };
  const color = (v: Value) => s.rt.toUint(v) & 0xffffff;
  // 8.8 fixed point, converted as x87 converts: past an int's range it is the indefinite, 0 once clamped.
  const strength = (v: Value) => {
    const fixed = Math.trunc(num(v) * 256);
    return Number.isFinite(fixed) && Math.abs(fixed) < 2 ** 31
      ? Math.max(0, Math.min(255 * 256, fixed)) / 256
      : 0;
  };
  // Within a turn either way, through radians and back, left to right as
  // adl's arithmetic goes: 300 is 300.00000000000006.
  const angle = (v: Value) => ((((num(v) % 360) * Math.PI) / 180) * 180) / Math.PI;
  const type = (v: Value) => {
    if (v === null || v === undefined) {
      throw s.rt.error("TypeError", 2007, "type");
    }

    const t = s.rt.toString(v);
    return t === "inner" || t === "outer" ? t : "full";
  };
  /** An int through x87's conversion: out of int32's range it is the indefinite, 0 once clamped. */
  const matrixSize = (v: Value) => {
    const n = Math.trunc(num(v));
    return Number.isFinite(n) && Math.abs(n) < 2 ** 31 ? Math.max(0, Math.min(15, n)) : 0;
  };
  const elements = (v: Value, name: string): Value[] => {
    if (v === null || v === undefined) {
      throw s.rt.error("TypeError", 2007, name);
    }

    return ((v as AsObject).$a as Value[] | undefined) ?? [];
  };
  // A hole is 0, as a missing value is; an undefined one is NaN.
  const floats = (values: Value[], length: number): number[] =>
    Array.from({ length }, (_, i) => (i in values ? Math.fround(num(values[i])) : 0));

  /** The conversion of each value every kind that has it keeps alike, by its record's key. */
  const converts: Record<string, (v: Value) => unknown> = {
    blurX: blur,
    blurY: blur,
    quality,
    alpha,
    color,
    strength,
    angle,
    distance: num,
    inner: Boolean,
    knockout: Boolean,
    hideObject: Boolean,
    highlightColor: color,
    highlightAlpha: alpha,
    shadowColor: color,
    shadowAlpha: alpha,
    type,
    divisor: (v) => Math.fround(num(v)),
    bias: (v) => Math.fround(num(v)),
    clamp: Boolean,
    preserveAlpha: Boolean,
    componentX: (v) => s.rt.toUint(v),
    componentY: (v) => s.rt.toUint(v),
    scaleX: (v) => scale(v),
    scaleY: (v) => scale(v),
  };
  const props: Record<string, Prop> = Object.fromEntries(
    Object.entries(converts).map(([key, convert]) => [
      key,
      [
        (f: Filter) => (f as unknown as Record<string, Value>)[key],
        (f: Filter, v: Value) => {
          (f as unknown as Record<string, unknown>)[key] = convert(v);
        },
      ],
    ]),
  );
  function scale(v: Value): number {
    const n = num(v);
    return Number.isNaN(n) ? n : Math.fround(Math.max(-65535, Math.min(65535, n)));
  }

  /**
   * A gradient's stops, at most 16, as adl keeps them: colours set their
   * count, padding alphas and ratios with 0; alphas fill to it, padding
   * with 1; ratios, truncated and clamped, can only make it fewer.
   */
  function gradientProps(): Record<string, Prop> {
    return {
      colors: [
        (f) => s.rt.array([...f.colors]),
        (f, v) => {
          f.colors = elements(v, "colors")
            .slice(0, 16)
            .map((c) => color(c));
          const n = f.colors.length;
          f.alphas = Array.from({ length: n }, (_, i) => f.alphas[i] ?? 0);
          f.ratios = Array.from({ length: n }, (_, i) => f.ratios[i] ?? 0);
        },
      ],
      alphas: [
        (f) => s.rt.array([...f.alphas]),
        (f, v) => {
          const values = elements(v, "alphas");
          f.alphas = Array.from({ length: f.colors.length }, (_, i) =>
            i < values.length ? alpha(values[i]) : 1,
          );
        },
      ],
      ratios: [
        (f) => s.rt.array([...f.ratios]),
        (f, v) => {
          const values = elements(v, "ratios");
          const n = Math.min(f.colors.length, values.length);
          f.colors.length = n;
          f.alphas.length = n;
          f.ratios = values.slice(0, n).map((r) => {
            const x = Math.trunc(num(r));
            return Number.isNaN(x) ? 0 : Math.max(0, Math.min(255, x));
          });
        },
      ],
    };
  }

  return { num, alpha, color, matrixSize, elements, floats, props, gradientProps };
}

/** A filter class's natives: its kind's record's properties of `props`, and its `own`. */
export function filterNatives(
  s: Scripting,
  kind: FilterKind,
  own: (values: ReturnType<typeof filterValues>) => Record<string, Prop> = () => ({}),
): avm2.Natives {
  const natives: avm2.Natives = {};
  const values = filterValues(s);
  const { props } = values;
  const name = filterClassName(kind).slice("flash.filters::".length);
  const defaults = filterDefaults(kind);
  const members: Record<string, PropertyDescriptor> = {};
  const all = {
    ...Object.fromEntries(
      Object.keys(props)
        .filter((k) => k in defaults)
        .map((k) => [k, props[k]]),
    ),
    ...own(values),
  };
  for (const [key, [get, set]] of Object.entries(all)) {
    members[key] = {
      get(this: AsObject) {
        return get(recordOf(this, kind));
      },
      set(this: AsObject, v: Value) {
        set(recordOf(this, kind), v);
      },
    };
  }

  const cls = class {};
  Object.defineProperties(cls.prototype, members);
  avm2.registerNativeClass(natives, `flash.filters::${name}`, cls);
  return natives;
}

/**
 * BitmapFilter, as adl has it: abstract, and restricted, so that only
 * playerglobal's own filters, and what extends them, are made; a script's
 * class extending it is refused as it is.
 */
export const bitmapFilterHooks: Record<string, avm2.ClassHook> = {
  "flash.filters::BitmapFilter": {
    construct: (rt) => {
      throw rt.error("ArgumentError", 2012, "BitmapFilter$");
    },
    restricted: true,
  },
};
