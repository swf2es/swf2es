// flash.filters' objects: each keeps its values as adl converts them, in a
// record (`$filter`) that DisplayObject.filters copies to and from the display
// object's (filters.ts in the player), so a filter read back is a copy.
import { avm2 } from "@swf2es/runtime";
import type { BitmapStore } from "../../../bitmap.js";
import { type Filter, type FilterKind, filterDefaults } from "../../../filters.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

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

/**
 * A copy of a displacement map's BitmapData, made as Flash makes it: a
 * plain BitmapData of the same pixels, not through the object's own
 * clone, which a script may override. Null for none, or one disposed.
 */
export function copyMap(s: Scripting, map: object | null): AsObject | null {
  const store = (map as { $store?: BitmapStore } | null)?.$store;
  if (!store || store.disposed) {
    return null;
  }

  const o = s.rt.construct(
    s.rt.classNamed("flash.display::BitmapData"),
    store.width,
    store.height,
    store.transparent,
    0,
  ) as AsObject;
  o.$store = store.clone();
  return o;
}

/** The record of a filter object, made with the kind's defaults when first touched. */
export function recordOf(o: AsObject, kind: FilterKind): Filter {
  o.$filter ??= filterDefaults(kind);
  return o.$filter;
}

/** A Number property's value as adl keeps it: alpha in 255ths, strength in 256ths, clamped. */
export function filterNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
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
  type Prop = [get: (f: Filter) => Value, set: (f: Filter, v: Value) => void];
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

  /** The properties each class has, beyond those of `props` its kind's record has. */
  const own: Record<FilterKind, Record<string, Prop>> = {
    blur: {},
    glow: {},
    dropShadow: {},
    bevel: {},
    gradientGlow: gradientProps(),
    gradientBevel: gradientProps(),
    colorMatrix: {
      matrix: [
        (f) => s.rt.array([...f.matrix]),
        (f, v) => {
          f.matrix = floats(elements(v, "matrix"), 20);
        },
      ],
    },
    convolution: {
      matrix: [
        (f) => s.rt.array([...f.matrix]),
        (f, v) => {
          f.matrix = floats(elements(v, "matrix"), f.matrixX * f.matrixY);
        },
      ],
      // Resized, the flat values stay in order, as many as fit, the rest 0.
      matrixX: [
        (f) => f.matrixX,
        (f, v) => {
          f.matrixX = matrixSize(v);
          f.matrix = floats(f.matrix, f.matrixX * f.matrixY);
        },
      ],
      matrixY: [
        (f) => f.matrixY,
        (f, v) => {
          f.matrixY = matrixSize(v);
          f.matrix = floats(f.matrix, f.matrixX * f.matrixY);
        },
      ],
    },
    displacementMap: {
      // A copy each way, as adl gives one: the map's pixels, the point in whole pixels.
      mapBitmap: [
        (f) => copyMap(s, f.mapBitmap),
        (f, v) => {
          f.mapBitmap = (v as AsObject | null) ?? null;
        },
      ],
      mapPoint: [
        (f) => s.rt.construct(s.rt.classNamed("flash.geom::Point"), f.mapPoint[0], f.mapPoint[1]),
        (f, v) => {
          const p = v as AsObject | null;
          f.mapPoint = p
            ? [
                Math.trunc(num(s.rt.getProperty(p, s.rt.publicName("x")))) || 0,
                Math.trunc(num(s.rt.getProperty(p, s.rt.publicName("y")))) || 0,
              ]
            : [0, 0];
        },
      ],
      mode: [
        (f) => f.mode,
        (f, v) => {
          if (v === null || v === undefined) {
            throw s.rt.error("TypeError", 2007, "mode");
          }

          const mode = s.rt.toString(v);
          if (!["wrap", "clamp", "ignore", "color"].includes(mode)) {
            throw s.rt.error("ArgumentError", 2008, "mode");
          }

          f.mode = mode;
        },
      ],
    },
  };

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

  for (const [name, kind] of CLASSES) {
    const defaults = filterDefaults(kind);
    const members: Record<string, PropertyDescriptor> = {};
    const all = {
      ...Object.fromEntries(
        Object.keys(props)
          .filter((k) => k in defaults)
          .map((k) => [k, props[k]]),
      ),
      ...own[kind],
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
  }

  return natives;
}

/**
 * BitmapFilter, as adl has it: abstract, and restricted, so that only
 * playerglobal's own filters, and what extends them, are made; a script's
 * class extending it is refused as it is.
 */
export const filterHooks: Record<string, avm2.ClassHook> = {
  "flash.filters::BitmapFilter": {
    construct: (rt) => {
      throw rt.error("ArgumentError", 2012, "BitmapFilter$");
    },
    restricted: true,
  },
};
