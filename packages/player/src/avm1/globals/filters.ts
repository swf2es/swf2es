// flash.filters' AS2 classes, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/bitmap_filter.rs, blur_filter.rs, glow_filter.rs,
// drop_shadow_filter.rs, bevel_filter.rs, gradient_filter.rs,
// color_matrix_filter.rs, convolution_filter.rs and
// displacement_map_filter.rs have them: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors. Each object holds the
// record a display object's filters keep (display/filters.ts), its values
// as Flash keeps them: an alpha in a byte, a strength in 256ths, a matrix
// in floats, a gradient in sixteen slots whose alphas and ratios outlast a
// shorter list. Its properties are getters and setters on the prototype,
// listed, from SWF 8; read of anything else they are undefined.
import { avm1 } from "@swf2es/runtime";
import type { BitmapStore } from "../../bitmap/bitmap.js";
import { type DisplayObject, TRANSFORM } from "../../display/display.js";
import { copyFilter, type Filter, type FilterKind, filterDefaults } from "../../display/filters.js";
import { makeGeom } from "./geom.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** A gradient's sixteen slots, as Flash keeps them: alphas in bytes. */
interface Slots {
  count: number;
  readonly colors: number[];
  readonly alphas: number[];
  readonly ratios: number[];
}

/** What a filter object holds: its record, a gradient's slots, a displacement map's bitmap. */
interface State {
  readonly f: Filter;
  slots: Slots | null;
  map: BitmapStore | null;
}

const MAX_COLORS = 16;

/** The angle a new shadow, bevel or gradient filter has: 0.785398163 radians, nearly 45°. */
const ANGLE = 0.785398163 * (180 / Math.PI);

const states = new WeakMap<Obj, State>();

/** The class names by kind, as `flash.filters` has them. */
const NAMES: Record<FilterKind, string> = {
  blur: "BlurFilter",
  glow: "GlowFilter",
  dropShadow: "DropShadowFilter",
  bevel: "BevelFilter",
  gradientGlow: "GradientGlowFilter",
  gradientBevel: "GradientBevelFilter",
  colorMatrix: "ColorMatrixFilter",
  convolution: "ConvolutionFilter",
  displacementMap: "DisplacementMapFilter",
};

/** A double as a byte as Rust casts it: truncated, saturating, NaN 0. */
const byte = (x: number) => (Number.isNaN(x) ? 0 : Math.max(0, Math.min(255, Math.trunc(x))));
/** A double as a u16 as Rust casts it. */
const u16 = (x: number) => (Number.isNaN(x) ? 0 : Math.max(0, Math.min(65535, Math.trunc(x))));
/** A double as an i32 as Rust casts it: saturating, NaN 0. */
const i32 = (x: number) =>
  Number.isNaN(x) ? 0 : Math.max(-0x80000000, Math.min(0x7fffffff, Math.trunc(x)));
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
/** A clamp that takes NaN to its low end. */
const clampNaN = (x: number, lo: number, hi: number) => (Number.isNaN(x) ? lo : clamp(x, lo, hi));

function newState(kind: FilterKind): State {
  const f = filterDefaults(kind);
  if ("angle" in f) {
    f.angle = ANGLE;
  }

  const gradient = kind === "gradientGlow" || kind === "gradientBevel";
  return {
    f,
    slots: gradient
      ? {
          count: 0,
          colors: new Array(MAX_COLORS).fill(0),
          alphas: new Array(MAX_COLORS).fill(0),
          ratios: new Array(MAX_COLORS).fill(0),
        }
      : null,
    map: null,
  };
}

/** A filter object's record, or null for anything else: what a display object or applyFilter takes. */
export function filterRecordOf(o: Value): Filter | null {
  const state = o instanceof avm1.Avm1Object ? states.get(o) : undefined;
  if (state === undefined) {
    return null;
  }

  const f = copyFilter(state.f);
  // The values a script may leave as NaN, drawn as none.
  for (const key of ["blurX", "blurY", "distance", "angle", "strength"] as const) {
    if (key in f && Number.isNaN(f[key])) {
      f[key] = 0;
    }
  }

  const slots = state.slots;
  if (slots) {
    f.colors = slots.colors.slice(0, slots.count);
    f.alphas = slots.alphas.slice(0, slots.count).map((a) => a / 255);
    f.ratios = slots.ratios.slice(0, slots.count);
  }

  if (f.kind === "convolution") {
    const n = f.matrixX * f.matrixY;
    f.matrix = Array.from({ length: n }, (_, i) => f.matrix[i] ?? 0);
  }

  if (f.kind === "displacementMap") {
    f.mapBitmap = state.map && !state.map.disposed ? { $store: state.map } : null;
  }

  return f;
}

/** The records' objects, as a display object's `filters` reads them: new each time. */
export interface FilterFaces {
  /** A new object of a record, of its class as `flash.filters` was made. */
  objectOf(f: Filter): Obj;
}

/**
 * A display object's `filters` set from a list: the records of its filter
 * objects up to its length, in order, anything else left out, so an object
 * without a length sets none (adl).
 */
export function filtersOf(value: Value, version: number): Filter[] {
  const out: Filter[] = [];
  const length = value instanceof avm1.Avm1Object ? lengthOf(value, version) : 0;
  for (let i = 0; i < length; i++) {
    const f = filterRecordOf(element(value, i, version));
    if (f !== null) {
      out.push(f);
    }
  }

  return out;
}

/** An object's `length` as Flash reads it for a list: a string's its length, 0 for no int. */
function lengthOf(value: Value, version: number): number {
  if (typeof value === "string") {
    return value.length;
  }

  if (!(value instanceof avm1.Avm1Object)) {
    return 0;
  }

  const n = avm1.toNumber(avm1.get(value, "length", version), version) | 0;
  return n < 0 ? 0 : n;
}

function element(value: Value, i: number, version: number): Value {
  return value instanceof avm1.Avm1Object ? avm1.get(value, String(i), version) : undefined;
}

/** What a property's getter makes of the player's: lists, bitmaps and points. */
interface Makers {
  list(values: number[], version: number): Value;
  bitmap(store: BitmapStore): Value;
  point(x: number, y: number, version: number): Value;
  /** A BitmapData object's store, null for anything else. */
  store(value: Value): BitmapStore | null;
}

/** A property: what it reads of the state, and what a value sets. */
type Getter = (s: State, version: number, make: Makers) => Value;
type Setter = (s: State, value: Value, version: number, make: Makers) => void;

interface Prop {
  readonly name: string;
  readonly get: Getter;
  readonly set: Setter;
}

const num = (v: Value, version: number) => avm1.toNumber(v, version);

function plain(name: keyof Filter, convert: (v: Value, version: number) => Value): Prop {
  return {
    name,
    get: (s) => s.f[name] as Value,
    set: (s, v, version) => {
      (s.f as unknown as Record<string, Value>)[name] = convert(v, version);
    },
  };
}

const distance = plain("distance", num);
const angle: Prop = {
  name: "angle",
  get: (s) => s.f.angle,
  set: (s, v, version) => {
    s.f.angle = (num(v, version) % 360) * (Math.PI / 180) * (180 / Math.PI);
  },
};
const quality = plain("quality", (v, version) => clamp(num(v, version) | 0, 0, 15));
const strength = plain(
  "strength",
  (v, version) => Math.min(u16(num(v, version) * 256), 0xff00) / 256,
);
const flag = (name: keyof Filter) => plain(name, (v, version) => avm1.toBoolean(v, version));
const blur = (name: "blurX" | "blurY", nanToZero = false) =>
  plain(name, (v, version) =>
    nanToZero ? clampNaN(num(v, version), 0, 255) : clamp(num(v, version), 0, 255),
  );
const rgb = (name: keyof Filter) => plain(name, (v, version) => (num(v, version) >>> 0) & 0xffffff);
/** An alpha kept in a byte; `unit` clamps it to 0 to 1 first, NaN 0. */
const alpha = (name: keyof Filter, unit = false) =>
  plain(name, (v, version) => {
    const a = num(v, version);
    return byte((unit ? clampNaN(a, 0, 1) : a) * 255) / 255;
  });
/** A bevel's type: inner, outer, or anything else full. */
const type = plain("type", (v, version) => {
  const t = avm1.stringOf(v, version);
  return t === "inner" || t === "outer" ? t : "full";
});

/** A gradient's lists: colors set the count, ratios may lower it, alphas never change it. */
const colors: Prop = {
  name: "colors",
  get: (s, version, make) => s.slots && make.list(s.slots.colors.slice(0, s.slots.count), version),
  set: (s, v, version) => {
    const slots = s.slots;
    if (!slots) {
      return;
    }

    slots.count = Math.min(lengthOf(v, version), MAX_COLORS);
    for (let i = 0; i < slots.count; i++) {
      slots.colors[i] = (num(element(v, i, version), version) | 0) & 0xffffff;
    }
  },
};
const alphas: Prop = {
  name: "alphas",
  get: (s, version, make) =>
    s.slots &&
    make.list(
      s.slots.alphas.slice(0, s.slots.count).map((a) => a / 255),
      version,
    ),
  set: (s, v, version) => {
    const slots = s.slots;
    if (!slots || !(v instanceof avm1.Avm1Object)) {
      return;
    }

    const length = lengthOf(v, version);
    for (let i = 0; i < slots.count; i++) {
      const a = i < length ? num(element(v, i, version), version) : Number.NaN;
      slots.alphas[i] = Number.isFinite(a) ? byte(255 * a + 0.5) : 255;
    }
  },
};
const ratios: Prop = {
  name: "ratios",
  get: (s, version, make) => s.slots && make.list(s.slots.ratios.slice(0, s.slots.count), version),
  set: (s, v, version) => {
    const slots = s.slots;
    if (!slots || !(v instanceof avm1.Avm1Object)) {
      return;
    }

    slots.count = Math.min(lengthOf(v, version), slots.count);
    for (let i = 0; i < slots.count; i++) {
      slots.ratios[i] = clamp(num(element(v, i, version), version) | 0, 0, 255);
    }
  },
};

/** A convolution's kernel grown, never shrunk, to its size. */
function fitKernel(f: Filter): void {
  const n = f.matrixX * f.matrixY;
  while (f.matrix.length < n) {
    f.matrix.push(0);
  }
}

const matrixSide = (name: "matrixX" | "matrixY"): Prop => ({
  name,
  get: (s) => s.f[name],
  set: (s, v, version) => {
    s.f[name] = clamp(num(v, version) | 0, 0, 15);
    fitKernel(s.f);
  },
});
const kernel: Prop = {
  name: "matrix",
  get: (s, version, make) => make.list(s.f.matrix, version),
  set: (s, v, version) => {
    const length = lengthOf(v, version);
    const matrix: number[] = [];
    for (let i = 0; i < length; i++) {
      matrix.push(Math.fround(num(element(v, i, version), version)));
    }

    s.f.matrix = matrix;
    fitKernel(s.f);
  },
};
const float = (name: keyof Filter) => plain(name, (v, version) => Math.fround(num(v, version)));

/** A colour matrix's twenty floats: an object's elements, NaN past them; anything else all NaN. */
const colorMatrix: Prop = {
  name: "matrix",
  get: (s, version, make) => make.list(s.f.matrix, version),
  set: (s, v, version) => {
    if (v === undefined || v === null) {
      return;
    }

    const matrix = new Array<number>(20).fill(Number.NaN);
    if (v instanceof avm1.Avm1Object) {
      for (let i = 0; i < 20; i++) {
        if (i < lengthOf(v, version)) {
          matrix[i] = Math.fround(num(element(v, i, version), version));
        }
      }
    }

    s.f.matrix = matrix;
  },
};

const mapBitmap: Prop = {
  name: "mapBitmap",
  get: (s, _, make) => (s.map ? make.bitmap(s.map) : undefined),
  set: (s, v, _, make) => {
    const store = make.store(v);
    if (store !== null) {
      s.map = store;
    }
  },
};
/**
 * The map's point, own x and y converted both before either error is
 * thrown, x's first; a point with only one of them, or no object, is (0, 0);
 * one that fails to convert is int's least.
 */
const mapPoint: Prop = {
  name: "mapPoint",
  get: (s, version, make) => make.point(s.f.mapPoint[0], s.f.mapPoint[1], version),
  set: (s, v, version) => {
    if (!(v instanceof avm1.Avm1Object)) {
      s.f.mapPoint = [0, 0];
      return;
    }

    const convert = (name: string): { n: number; error: unknown } | null => {
      const p = v.own(name, version);
      if (p === undefined) {
        return null;
      }

      try {
        return { n: i32(num(p.value, version)), error: null };
      } catch (error) {
        return { n: -0x80000000, error };
      }
    };
    const x = convert("x");
    const y = convert("y");
    s.f.mapPoint = x && y ? [x.n, y.n] : [0, 0];
    if (x?.error) {
      throw x.error;
    }

    if (y?.error) {
      throw y.error;
    }
  },
};
const component = (name: "componentX" | "componentY") =>
  plain(name, (v, version) => num(v, version) | 0);
const scale = (name: "scaleX" | "scaleY") =>
  plain(name, (v, version) => Math.fround(clampNaN(num(v, version), -65535, 65535)));
const mode = plain("mode", (v, version) => {
  const m = avm1.stringOf(v, version);
  return m === "clamp" || m === "ignore" || m === "color" ? m : "wrap";
});

/** Each class's properties in Flash's order, and its constructor's arguments in theirs. */
const CLASSES: Record<FilterKind, { props: Prop[]; args: Prop[] }> = (() => {
  const [blurX, blurY] = [blur("blurX"), blur("blurY")];
  const [color, a] = [rgb("color"), alpha("alpha")];
  const [inner, knockout] = [flag("inner"), flag("knockout")];
  const highlightColor = rgb("highlightColor");
  const highlightAlpha = alpha("highlightAlpha");
  const shadowColor = rgb("shadowColor");
  const shadowAlpha = alpha("shadowAlpha");
  const [gBlurX, gBlurY] = [blur("blurX", true), blur("blurY", true)];
  const gradient = {
    props: [
      distance,
      angle,
      colors,
      alphas,
      ratios,
      gBlurX,
      gBlurY,
      quality,
      strength,
      knockout,
      type,
    ],
    args: [
      distance,
      angle,
      colors,
      alphas,
      ratios,
      gBlurX,
      gBlurY,
      strength,
      quality,
      type,
      knockout,
    ],
  };
  const [divisor, bias] = [float("divisor"), float("bias")];
  const unitAlpha = alpha("alpha", true);
  return {
    blur: { props: [blurX, blurY, quality], args: [blurX, blurY, quality] },
    glow: {
      props: [color, a, quality, inner, knockout, blurX, blurY, strength],
      args: [color, a, blurX, blurY, strength, quality, inner, knockout],
    },
    dropShadow: {
      props: [
        distance,
        angle,
        color,
        a,
        quality,
        inner,
        knockout,
        blurX,
        blurY,
        strength,
        flag("hideObject"),
      ],
      args: [
        distance,
        angle,
        color,
        a,
        blurX,
        blurY,
        strength,
        quality,
        inner,
        knockout,
        flag("hideObject"),
      ],
    },
    bevel: {
      props: [
        distance,
        angle,
        highlightColor,
        highlightAlpha,
        shadowColor,
        shadowAlpha,
        quality,
        strength,
        knockout,
        blurX,
        blurY,
        type,
      ],
      args: [
        distance,
        angle,
        highlightColor,
        highlightAlpha,
        shadowColor,
        shadowAlpha,
        blurX,
        blurY,
        strength,
        quality,
        type,
        knockout,
      ],
    },
    gradientGlow: gradient,
    gradientBevel: gradient,
    colorMatrix: { props: [colorMatrix], args: [colorMatrix] },
    convolution: {
      props: [
        matrixSide("matrixX"),
        matrixSide("matrixY"),
        kernel,
        divisor,
        bias,
        flag("preserveAlpha"),
        flag("clamp"),
        rgb("color"),
        unitAlpha,
      ],
      // Its divisor and colour are the constructor's own (see below).
      args: [matrixSide("matrixX"), matrixSide("matrixY"), kernel],
    },
    displacementMap: {
      props: [
        mapBitmap,
        mapPoint,
        component("componentX"),
        component("componentY"),
        scale("scaleX"),
        scale("scaleY"),
        mode,
        rgb("color"),
        unitAlpha,
      ],
      args: [
        mapBitmap,
        mapPoint,
        component("componentX"),
        component("componentY"),
        scale("scaleX"),
        scale("scaleY"),
        mode,
        rgb("color"),
        unitAlpha,
      ],
    },
  };
})();

/**
 * A convolution's constructor past its kernel: a divisor not given is the
 * kernel's sum where any argument is; a colour given makes its alpha 1,
 * the documentation aside (Ruffle).
 */
function constructConvolution(s: State, args: Value[], version: number): void {
  const f = s.f;
  if (args.length > 3) {
    f.divisor = Math.fround(num(args[3], version));
  } else if (args.length > 0) {
    f.divisor = Math.fround(f.matrix.reduce((sum, x) => Math.fround(sum + x), 0));
  }

  if (args.length > 4) {
    f.bias = Math.fround(num(args[4], version));
  }

  if (args.length > 5) {
    f.preserveAlpha = avm1.toBoolean(args[5], version);
  }

  if (args.length > 6) {
    f.clamp = avm1.toBoolean(args[6], version);
  }

  if (args.length > 7) {
    f.color = (num(args[7], version) >>> 0) & 0xffffff;
    f.alpha = 1;
  }

  if (args.length > 8) {
    f.alpha = byte(clampNaN(num(args[8], version), 0, 1) * 255) / 255;
  }
}

/** What the package needs of the player: AVM1 objects of a bitmap. */
export interface FiltersHost {
  readonly realm: avm1.Realm;
  /** A BitmapData object of `store`, new each time. */
  bitmapObject(store: BitmapStore): Obj;
  /** A BitmapData object's store, null for anything else. */
  storeOf(value: Value): BitmapStore | null;
}

/** `flash.filters`, its classes on `filters`; what reads a display object's filters back. */
export function filtersPackage(host: FiltersHost, filters: Obj): FilterFaces {
  const realm = host.realm;
  const make: Makers = {
    list: (values, version) => realm.newArray([...values], version),
    bitmap: (store) => host.bitmapObject(store),
    point: (x, y, version) => makeGeom(realm, "Point", [x, y], version),
    store: (value) => host.storeOf(value),
  };

  /** A native function as a class's constructor, `prototype` and `constructor` its own. */
  const classOf = (proto: Obj, construct: avm1.Native): avm1.Avm1Function => {
    const constr = new avm1.Avm1Function(undefined, realm, () => undefined, construct);
    constr.define("prototype", proto, avm1.DONT_ENUM | avm1.DONT_DELETE);
    constr.define("constructor", realm.Function, avm1.DONT_ENUM | avm1.DONT_DELETE);
    constr.define(
      "__proto__",
      realm.functionProto,
      avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.VERSION_6,
    );
    return constr;
  };

  // BitmapFilter: no state of its own, a clone that copies a filter's.
  const base = new avm1.Avm1Object(realm.objectProto);
  const baseClass = classOf(base, (self) => self);
  base.define("constructor", baseClass, avm1.DONT_ENUM | avm1.DONT_DELETE);
  base.define(
    "clone",
    realm.method((self) => {
      const state = states.get(self);
      if (state === undefined) {
        return undefined;
      }

      const copy = new avm1.Avm1Object(self.proto);
      states.set(copy, cloneState(state));
      return copy;
    }),
    0,
  );
  filters.define("BitmapFilter", baseClass, 0);

  const protos = new Map<FilterKind, Obj>();
  // Defined in Flash's order, for..in lists them the other way round.
  const order: FilterKind[] = [
    "dropShadow",
    "blur",
    "glow",
    "bevel",
    "gradientGlow",
    "gradientBevel",
    "convolution",
    "colorMatrix",
    "displacementMap",
  ];
  for (const kind of order) {
    const { props, args } = CLASSES[kind];
    // As a class that extends BitmapFilter: its __constructor__, no constructor.
    const proto = new avm1.Avm1Object(base);
    proto.define("__constructor__", baseClass, avm1.DONT_ENUM);
    const constr = classOf(proto, (self, given, version) => {
      const state = newState(kind);
      for (let i = 0; i < args.length && i < given.length; i++) {
        args[i].set(state, given[i], version, make);
      }

      if (kind === "convolution") {
        constructConvolution(state, given, version);
      }

      states.set(self, state);
      return self;
    });
    for (const prop of props) {
      const p = proto.add(prop.name, undefined, avm1.VERSION_8);
      p.get = realm.method((self, _, version) => {
        const state = states.get(self);
        return state === undefined ? undefined : prop.get(state, version, make);
      });
      p.set = realm.method((self, values, version) => {
        const state = states.get(self);
        if (state !== undefined) {
          prop.set(state, values[0], version, make);
        }

        return undefined;
      });
    }

    protos.set(kind, proto);
    filters.define(NAMES[kind], constr, 0);
  }

  return {
    objectOf(f) {
      const o = new avm1.Avm1Object(protos.get(f.kind));
      states.set(o, stateOf(f));
      return o;
    },
  };
}

/** A state of a display object's record, as its `filters` reads it. */
function stateOf(record: Filter): State {
  const f = copyFilter(record);
  const state: State = { f, slots: null, map: null };
  if (f.kind === "gradientGlow" || f.kind === "gradientBevel") {
    const count = Math.min(f.colors.length, MAX_COLORS);
    const fill = (values: number[]) => [
      ...values.slice(0, count),
      ...new Array(MAX_COLORS - count).fill(0),
    ];
    state.slots = {
      count,
      colors: fill(f.colors),
      alphas: fill(f.alphas.map((a) => Math.round(a * 255))),
      ratios: fill(f.ratios),
    };
  }

  if (f.kind === "displacementMap") {
    state.map = (f.mapBitmap as { $store?: BitmapStore } | null)?.$store ?? null;
    f.mapSnapshot = undefined;
  }

  return state;
}

function cloneState(s: State): State {
  const slots = s.slots;
  return {
    f: copyFilter(s.f),
    slots: slots
      ? {
          count: slots.count,
          colors: [...slots.colors],
          alphas: [...slots.alphas],
          ratios: [...slots.ratios],
        }
      : null,
    map: s.map,
  };
}

/**
 * A display object's `filters` on its class's prototype, of `flags`: a new
 * array of new filter objects each read; a list's filter objects set them.
 */
export function filtersProperty(
  realm: avm1.Realm,
  proto: Obj,
  flags: number,
  targetOf: (self: Obj) => DisplayObject | null,
  faces: () => FilterFaces | null,
): void {
  const p = proto.add("filters", undefined, flags);
  p.get = realm.method((self, _, version) => {
    const d = targetOf(self);
    const made = faces();
    return d === null || made === null
      ? undefined
      : realm.newArray(
          d.filters.map((f) => made.objectOf(f)),
          version,
        );
  });
  p.set = realm.method((self, args, version) => {
    const d = targetOf(self);
    if (d !== null) {
      setDisplayFilters(d, args[0], version);
    }

    return undefined;
  });
}

/**
 * A display object's `filters` set: the records of the filter objects in
 * the array, anything else left out; a displacement map's pixels taken as
 * they are now, as AS3's are.
 */
export function setDisplayFilters(d: DisplayObject, value: Value, version: number): void {
  const list = filtersOf(value, version);
  for (const f of list) {
    const store = (f.mapBitmap as { $store?: BitmapStore } | null)?.$store;
    if (f.kind === "displacementMap" && store) {
      f.mapSnapshot = { $store: store.clone() };
    }
  }

  d.touch();
  d.filters = list;
  d.invalidate(TRANSFORM);
}
