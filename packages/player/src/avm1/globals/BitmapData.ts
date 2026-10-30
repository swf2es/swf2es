// flash.display.BitmapData's AS2 face, as Ruffle's (https://github.com/
// ruffle-rs/ruffle) core/src/avm1/globals/bitmap_data.rs has it: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// Each object holds a BitmapStore, the player's bitmap, whose operations
// AS3's BitmapData shares (bitmap/bitmap.ts, bitmap/ops.ts); a display
// object is drawn into one by the host's renderer, as AS3's draw is. What
// AS3 throws, AS2 answers with a number: -1 for too few arguments or a
// disposed bitmap, -2 for a source that is none, -3 for a disposed one,
// -4 for a rectangle that is none.
import { avm1 } from "@swf2es/runtime";
import { BitmapStore, pixelRect, spanRect } from "../../bitmap/bitmap.js";
import { drawDisplayObject } from "../../bitmap/draw.js";
import { applyFilter, filterRefusal, GLOWS, generatedRect } from "../../bitmap/filters.js";
import {
  alphaAt,
  type ColorTransformValues,
  colorBounds,
  colorTransform,
  comparePixels,
  copyChannel,
  drawBitmap,
  floodFill,
  isThresholdOperation,
  merge,
  noise,
  paletteMap,
  perlinNoise,
  pixelDissolve,
  scroll,
  threshold,
} from "../../bitmap/ops.js";
import type { DisplayObject } from "../../display/display.js";
import { BLEND_MODES } from "../../display/displayobject.js";
import type { Drawer } from "../../hosts.js";
import { filterRecordOf } from "./filters.js";
import { colorValues, type GeomHost, makeGeom } from "./geom.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** What BitmapData reads of the movie. */
export interface BitmapHost extends GeomHost {
  /** The host's renderer, which a display object is drawn by; null where there is none. */
  readonly drawer: Drawer | null;
  /** The stage's quality, which a display object is drawn at. */
  readonly quality: string;
  /** The library's bitmap exported as `name`, as a new store; null where there is none. */
  libraryBitmap(name: string): BitmapStore | null;
}

/** Each BitmapData's store, by its AVM1 object. */
const stores = new WeakMap<Obj, BitmapStore>();

/** A new BitmapData object of `proto` showing `store`, as a displacement map's `mapBitmap` reads it. */
export function bitmapObject(proto: Value, store: BitmapStore): Obj {
  const o = new avm1.Avm1Object(proto);
  stores.set(o, store);
  return o;
}

/** `o`'s store where it is a BitmapData, disposed or not; null for anything else. */
export function storeOf(o: Value): BitmapStore | null {
  return o instanceof avm1.Avm1Object ? (stores.get(o) ?? null) : null;
}

/**
 * Whether a bitmap of `w` by `h` may be made in SWF `version`: up to SWF 9
 * 2880 a side; to 12 under 8192 a side and 2^24 pixels; from 13 up to
 * 0x6666666 a side and under 2^29 pixels (Ruffle's is_size_valid).
 */
function sizeValid(w: number, h: number, version: number): boolean {
  if (w === 0 || h === 0) {
    return false;
  }

  if (version <= 9) {
    return w <= 2880 && h <= 2880;
  }

  if (version <= 12) {
    return w < 8192 && h < 8192 && w * h < 0x1000000;
  }

  return w <= 0x6666666 && h <= 0x6666666 && w * h < 0x20000000;
}

/**
 * A rectangle's own or inherited x, y, width and height as ints, clipped
 * as Flash clips, a negative size spanning back with `span`; null if one
 * is missing.
 */
function rectOf(o: Value, v: number, span = false, ints = true) {
  if (!(o instanceof avm1.Avm1Object)) {
    return null;
  }

  const names = ["x", "y", "width", "height"];
  if (names.some((n) => !avm1.has(o, n, v))) {
    return null;
  }

  const [x, y, w, h] = names.map((n) => {
    const d = avm1.toNumber(avm1.get(o, n, v), v);
    return ints ? d | 0 : d;
  });
  return (span ? spanRect : pixelRect)(x, y, w, h);
}

/** A point's own x and y as ints, as hitTest takes them; null if either is not its own. */
function ownPoint(o: Value, v: number): [number, number] | null {
  if (
    !(o instanceof avm1.Avm1Object) ||
    o.own("x", v) === undefined ||
    o.own("y", v) === undefined
  ) {
    return null;
  }

  return [avm1.toNumber(avm1.get(o, "x", v), v) | 0, avm1.toNumber(avm1.get(o, "y", v), v) | 0];
}

/** An alpha threshold: an int clamped to a byte. */
function threshold8(x: Value, v: number): number {
  return Math.max(0, Math.min(255, avm1.toNumber(x, v) | 0));
}

/** A point's x and y, truncated to ints. */
function pointOf(o: Value, v: number): [number, number] {
  const coord = (n: string) =>
    Math.trunc(avm1.toNumber(o instanceof avm1.Avm1Object ? avm1.get(o, n, v) : undefined, v)) | 0;
  return [coord("x"), coord("y")];
}

/** A matrix's six fields as numbers, the identity's where it is none. */
function matrixOf(o: Value, v: number) {
  if (!(o instanceof avm1.Avm1Object)) {
    return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  }

  const n = (name: string) => avm1.toNumber(avm1.get(o, name, v), v);
  return { a: n("a"), b: n("b"), c: n("c"), d: n("d"), tx: n("tx"), ty: n("ty") };
}

/**
 * A blend mode as AVM1 takes one: a name as BlendMode has it, or
 * PlaceObject3's number of one, a byte, undefined and null normal; null for
 * anything else, a name in another case or a number in a string included
 * (adl, the corpus's movieclip_blend_mode_property).
 */
export function blendModeOf(value: Value): string | null {
  if (value === undefined || value === null) {
    return "normal";
  }

  if (typeof value === "number") {
    return BLEND_MODES[(Number.isFinite(value) ? Math.trunc(value) : 0) & 0xff] ?? null;
  }

  return typeof value === "string" && BLEND_MODES.includes(value) ? value : null;
}

/** A native ColorTransform's values as a colour transform; null for anything else. */
function colorOf(o: Value): ColorTransformValues | null {
  const c = colorValues(o);
  return c
    ? {
        rMul: c[0],
        gMul: c[1],
        bMul: c[2],
        aMul: c[3],
        rAdd: c[4],
        gAdd: c[5],
        bAdd: c[6],
        aAdd: c[7],
      }
    : null;
}

/** Samples a side a display object is drawn at, by the stage's quality: Flash's 1, 2 and 4. */
function samplesOf(quality: string): number {
  switch (quality) {
    case "LOW":
      return 1;
    case "MEDIUM":
      return 2;
    default:
      return 4;
  }
}

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE;

/** `flash.display.BitmapData`. */
export function bitmapDataClass(host: BitmapHost): Obj {
  const realm = host.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self, args, v) => {
      // Fewer than two arguments, or a size Flash does not make, and `new` gives undefined.
      if (args.length < 2) {
        return undefined;
      }

      const w = avm1.toNumber(args[0], v) >>> 0;
      const h = avm1.toNumber(args[1], v) >>> 0;
      if (!sizeValid(w, h, host.version)) {
        return undefined;
      }

      // An explicit undefined or null is false, and a fill of 0.
      const transparent = args.length < 3 || avm1.toBoolean(args[2], v);
      const fill = args.length < 4 ? 0xffffffff : avm1.toNumber(args[3], v) >>> 0;
      stores.set(self, new BitmapStore(w, h, transparent, Number.isNaN(fill) ? 0 : fill));
      return self;
    },
    () => undefined,
  );

  /** A method of a live bitmap: -1 for a disposed one, or one with fewer than `least` arguments. */
  const method = (
    name: string,
    least: number,
    f: (store: BitmapStore, args: Value[], v: number, self: Obj) => Value,
  ) => {
    proto.define(
      name,
      realm.method((self, args, v) => {
        const store = stores.get(self);
        return store === undefined || store.disposed || args.length < least
          ? -1
          : f(store, args, v, self);
      }),
      0,
    );
  };
  const getter = (name: string, f: (store: BitmapStore, v: number) => Value) => {
    const p = proto.add(name, undefined, 0);
    p.get = realm.method((self, _, v) => {
      const store = stores.get(self);
      return store === undefined || store.disposed ? -1 : f(store, v);
    });
    // Assigning to it does nothing.
    p.set = realm.method(() => undefined);
  };

  getter("width", (store) => store.width);
  getter("height", (store) => store.height);
  getter("transparent", (store) => store.transparent);
  getter("rectangle", (store, v) =>
    makeGeom(realm, "Rectangle", [0, 0, store.width, store.height], v),
  );

  method(
    "getPixel",
    2,
    (store, args, v) =>
      store.getPixel(avm1.toNumber(args[0], v) | 0, avm1.toNumber(args[1], v) | 0) | 0,
  );
  method(
    "getPixel32",
    2,
    (store, args, v) =>
      store.getPixel32(avm1.toNumber(args[0], v) | 0, avm1.toNumber(args[1], v) | 0) | 0,
  );
  method("setPixel", 3, (store, args, v) => {
    store.setPixel(
      avm1.toNumber(args[0], v) | 0,
      avm1.toNumber(args[1], v) | 0,
      avm1.toNumber(args[2], v) >>> 0,
    );
    return 0;
  });
  method("setPixel32", 3, (store, args, v) => {
    store.setPixel32(
      avm1.toNumber(args[0], v) | 0,
      avm1.toNumber(args[1], v) | 0,
      avm1.toNumber(args[2], v) >>> 0,
    );
    return 0;
  });
  method("fillRect", 2, (store, args, v) => {
    const r = rectOf(args[0], v);
    if (r === null) {
      return -1;
    }

    store.fillRect(r, avm1.toNumber(args[1], v) >>> 0);
    return 0;
  });
  method("copyPixels", 3, (store, args, v) => {
    const source = storeOf(args[0]);
    if (source === null) {
      return -2;
    }

    if (source.disposed) {
      return -3;
    }

    const r = rectOf(args[1], v);
    if (r === null) {
      return -4;
    }

    const [dx, dy] = pointOf(args[2], v);
    // An alpha bitmap counts only with its point given, and mergeAlpha is
    // false unless given, whatever the documentation says (the corpus's
    // bitmap_data_thorough).
    const alpha = args.length >= 5 ? storeOf(args[3]) : null;
    const merge = args.length >= 6 && avm1.toBoolean(args[5], v);
    if (alpha !== null && !alpha.disposed) {
      const [ax, ay] = pointOf(args[4], v);
      store.copyPixels(source, r, dx, dy, merge, alpha, ax, ay);
    } else {
      store.copyPixels(source, r, dx, dy, merge);
    }

    return 0;
  });
  method("draw", 0, (store, args, v) => {
    // A matrix given as null or undefined draws nothing, -4, before the source is looked at;
    // a draw returns 0, no source -2, a disposed one -3 (adl).
    if (args.length > 1 && (args[1] === null || args[1] === undefined)) {
      return -4;
    }

    const m = matrixOf(args[1], v);
    const c = colorOf(args[2]);
    // draw takes anything that is no blend mode as normal (adl).
    const blend = blendModeOf(args[3]) ?? "normal";
    const clip = args.length > 4 ? rectOf(args[4], v) : null;
    const smooth = args.length > 5 && avm1.toBoolean(args[5], v);
    const source = storeOf(args[0]);
    if (source !== null) {
      if (source.disposed) {
        return -3;
      }

      // Into itself a row at a time, as AS3's BitmapData draws (adl, avm1-draw-self).
      drawBitmap(store, source, m, c, blend, clip, smooth, true);
      return 0;
    }

    const d = displayOf(args[0]);
    if (d === null) {
      return -2;
    }

    // Without a renderer nothing is drawn: there is no other way to draw a display object.
    if (host.drawer !== null) {
      drawDisplayObject(host.drawer, store, d, m, c, blend, clip, samplesOf(host.quality));
    }

    return 0;
  });
  method("clone", 0, (store, _, v, self) => {
    // A bare object of this one's prototype, a subclass's too (Ruffle).
    const copy = new avm1.Avm1Object(avm1.get(self, "__proto__", v));
    stores.set(copy, store.clone());
    return copy;
  });
  method("dispose", 0, (store) => {
    store.dispose();
    return undefined;
  });
  // 1 where it filled, 0 for a point off the bitmap or a fill of the colour already there.
  method("floodFill", 3, (store, args, v) => {
    const x = avm1.toNumber(args[0], v) >>> 0;
    const y = avm1.toNumber(args[1], v) >>> 0;
    const color = avm1.toNumber(args[2], v) >>> 0;
    if (
      x >= store.width ||
      y >= store.height ||
      store.pixels[y * store.width + x] === store.premultiplied(color)
    ) {
      return 0;
    }

    floodFill(store, x, y, color);
    return 1;
  });
  method("scroll", 2, (store, args, v) => {
    scroll(store, avm1.toNumber(args[0], v) | 0, avm1.toNumber(args[1], v) | 0);
    return 0;
  });
  // A filter's rect is not worked out yet (Ruffle's neither).
  // -1 for no rect, -2 for no filter object (adl).
  method("generateFilterRect", 2, (store, args, v) => {
    const r = rectOf(args[0], v);
    if (r === null) {
      return -1;
    }

    const f = filterRecordOf(args[1]);
    if (f === null) {
      return -2;
    }

    const g = generatedRect(store.width, store.height, r, f);
    return makeGeom(realm, "Rectangle", [g.x, g.y, g.width, g.height], v);
  });
  // AS3's operation, its errors numbers (adl): -4 for no rect, -5 for no filter object, -6 for a
  // glow, shadow or bevel into an opaque bitmap; a point that is none is (0, 0).
  method("applyFilter", 4, (store, args, v) => {
    const source = storeOf(args[0]);
    if (source === null) {
      return -2;
    }

    if (source.disposed) {
      return -3;
    }

    // Its rect's numbers as AS3's are, not as ints: an edge of NaN or of
    // Infinity is refused as AS3 refuses it (adl).
    const r = rectOf(args[1], v, false, false);
    if (r === null) {
      return -4;
    }

    const f = filterRecordOf(args[3]);
    if (f === null) {
      return -5;
    }

    // What AS3 refuses with an error, an edge or a size past what Flash makes its buffers for,
    // AVM1 answers -6 for too (adl).
    const refused =
      filterRefusal(r, f, { x: 0, y: 0, width: source.width, height: source.height }) !== 0;
    if (refused || (!store.transparent && GLOWS.has(f.kind))) {
      return -6;
    }

    const [dx, dy] = pointOf(args[2], v);
    const map = (f.mapBitmap as { $store?: BitmapStore } | null)?.$store ?? null;
    applyFilter(store, source, r, dx, dy, f, map);
    return 0;
  });
  method("colorTransform", 2, (store, args, v) => {
    const r = rectOf(args[0], v);
    if (r === null) {
      return -2;
    }

    const c = colorOf(args[1]);
    if (c === null) {
      return -3;
    }

    colorTransform(store, r, c);
    return -1;
  });

  /**
   * The source, rect and destination point the copying methods take: -2
   * for a source that is no BitmapData, -3 for a disposed one, -4 for a
   * rect that is none. Their rect spans back from a negative size, as AS3's
   * does.
   */
  const copyArgs = (args: Value[], v: number) => {
    const source = storeOf(args[0]);
    if (source === null) {
      return -2;
    }

    if (source.disposed) {
      return -3;
    }

    const r = rectOf(args[1], v, true);
    if (r === null) {
      return -4;
    }

    const [dx, dy] = pointOf(args[2], v);
    return { source, r, dx, dy };
  };
  // An argument left out takes its default; one given as undefined is converted, as Flash does.
  const given = (args: Value[], i: number) => args.length > i;

  method("copyChannel", 5, (store, args, v) => {
    const a = copyArgs(args, v);
    if (typeof a === "number") {
      return a;
    }

    const from = avm1.toNumber(args[3], v) | 0;
    const to = avm1.toNumber(args[4], v) | 0;
    copyChannel(store, a.source, a.r, a.dx, a.dy, from >>> 0, to >>> 0);
    return -1;
  });
  method("merge", 6, (store, args, v) => {
    const a = copyArgs(args, v);
    if (typeof a === "number") {
      return a;
    }

    // The alpha multiplier may be left out, whatever the documentation says; each is an int
    // clamped to 0 to 256, where AS3's is a uint taken as it is (Ruffle).
    const muls = [3, 4, 5, 6].map((i) =>
      i === 6 && !given(args, i) ? 0xff : Math.max(0, Math.min(256, avm1.toNumber(args[i], v) | 0)),
    );
    merge(store, a.source, a.r, a.dx, a.dy, muls as [number, number, number, number]);
    return -1;
  });
  // Three arguments are enough by the documentation, but without the red table it does nothing.
  method("paletteMap", 4, (store, args, v) => {
    const a = copyArgs(args, v);
    if (typeof a === "number") {
      return a;
    }

    // A channel without a table, an object, maps to itself.
    const table = (t: Value, shift: number) =>
      Uint32Array.from({ length: 256 }, (_, i) =>
        t instanceof avm1.Avm1Object
          ? avm1.toNumber(avm1.get(t, String(i), v), v) >>> 0
          : (i << shift) >>> 0,
      );
    paletteMap(store, a.source, a.r, a.dx, a.dy, [
      table(args[3], 16),
      table(args[4], 8),
      table(args[5], 0),
      table(args[6], 24),
    ]);
    return -1;
  });
  method("threshold", 5, (store, args, v) => {
    const a = copyArgs(args, v);
    if (typeof a === "number") {
      return a;
    }

    // An operation threshold does not know is "<".
    const op = avm1.stringOf(args[3], v);
    return threshold(
      store,
      a.source,
      a.r,
      a.dx,
      a.dy,
      isThresholdOperation(op) ? op : "<",
      avm1.toNumber(args[4], v) >>> 0,
      avm1.toNumber(args[5], v) >>> 0,
      given(args, 6) ? avm1.toNumber(args[6], v) >>> 0 : 0xffffffff,
      avm1.toBoolean(args[7], v),
      true,
    );
  });
  // Four arguments are enough by the documentation, but without numPixels it does nothing.
  method("pixelDissolve", 5, (store, args, v) => {
    const a = copyArgs(args, v);
    if (typeof a === "number") {
      return a;
    }

    return pixelDissolve(
      store,
      a.source,
      a.r,
      a.dx,
      a.dy,
      avm1.toNumber(args[3], v) | 0,
      // A negative count is a uint's, which comes round the rect as any other.
      avm1.toNumber(args[4], v) >>> 0,
      given(args, 5) ? avm1.toNumber(args[5], v) >>> 0 : 0,
    );
  });
  method("noise", 1, (store, args, v) => {
    // The bounds are ints clamped to a byte, not bytes, so a negative low is 0.
    const byte = (x: Value) => Math.max(0, Math.min(255, avm1.toNumber(x, v) | 0));
    noise(
      store,
      avm1.toNumber(args[0], v) | 0,
      byte(args[1]),
      given(args, 2) ? byte(args[2]) : 255,
      given(args, 3) ? (avm1.toNumber(args[3], v) | 0) & 0xf : 7,
      avm1.toBoolean(args[4], v),
    );
    return 0;
  });
  method("perlinNoise", 6, (store, args, v) => {
    // Past 1024 octaves the sum no longer changes (the AS3 face's perlinNoise).
    const count = Math.min(Math.max(0, avm1.toNumber(args[2], v) | 0), 1024);
    const offsets = args[8];
    const shifts = Array.from({ length: count }, (_, i): [number, number] => {
      const p = offsets instanceof avm1.Avm1Object ? avm1.get(offsets, String(i), v) : undefined;
      return p instanceof avm1.Avm1Object
        ? [avm1.toNumber(avm1.get(p, "x", v), v), avm1.toNumber(avm1.get(p, "y", v), v)]
        : [0, 0];
    });
    perlinNoise(
      store,
      [avm1.toNumber(args[0], v), avm1.toNumber(args[1], v)],
      shifts,
      avm1.toNumber(args[3], v) | 0,
      avm1.toBoolean(args[4], v),
      avm1.toBoolean(args[5], v),
      given(args, 6) ? (avm1.toNumber(args[6], v) | 0) & 0xf : 7,
      avm1.toBoolean(args[7], v),
    );
    return 0;
  });
  method("getColorBoundsRect", 2, (store, args, v) => {
    const r = colorBounds(
      store,
      avm1.toNumber(args[0], v) >>> 0,
      avm1.toNumber(args[1], v) >>> 0,
      !given(args, 2) || avm1.toBoolean(args[2], v),
      true,
    );
    return makeGeom(realm, "Rectangle", [r.x, r.y, r.width, r.height], v);
  });
  // compare's answers are its own: -1 for no argument, -2 for one that is no live BitmapData,
  // -3 and -4 for another width and height, 0 for the same pixels.
  method("compare", 1, (store, args, v, self) => {
    const other = storeOf(args[0]);
    if (other === null || other.disposed) {
      return -2;
    }

    if (other.width !== store.width) {
      return -3;
    }

    if (other.height !== store.height) {
      return -4;
    }

    const pixels = comparePixels(store, other);
    if (pixels === null) {
      return 0;
    }

    const diff = new BitmapStore(store.width, store.height, true, 0);
    diff.pixels.set(pixels);
    diff.changed();
    const o = new avm1.Avm1Object(avm1.get(self, "__proto__", v));
    stores.set(o, diff);
    return o;
  });
  method("hitTest", 3, (store, args, v) => {
    // Despite the documentation's Boolean, the errors are negative numbers.
    const first = ownPoint(args[0], v);
    if (first === null) {
      return -2;
    }

    const [fx, fy] = first;
    const a1 = threshold8(args[1], v);
    const second = args[2];
    const other = storeOf(second);
    if (other !== null) {
      if (other.disposed) {
        return -3;
      }

      // The second point may be left out, but not be given as something else.
      const at = ownPoint(args[3], v);
      if (at === null && given(args, 3)) {
        return -4;
      }

      const [sx, sy] = at ?? [0, 0];
      const a2 = threshold8(args[4], v);
      const ox = sx - fx;
      const oy = sy - fy;
      for (let y = Math.max(0, oy); y < Math.min(store.height, oy + other.height); y++) {
        for (let x = Math.max(0, ox); x < Math.min(store.width, ox + other.width); x++) {
          if (alphaAt(store, x, y) >= a1 && alphaAt(other, x - ox, y - oy) >= a2) {
            return true;
          }
        }
      }

      return false;
    }

    // A point or a rectangle, duck-typed by its own fields.
    if (!(second instanceof avm1.Avm1Object)) {
      return -3;
    }

    const field = (n: string) =>
      second.own(n, v) === undefined ? null : avm1.toNumber(avm1.get(second, n, v), v) | 0;
    const [x, y, w, h] = ["x", "y", "width", "height"].map(field);
    if (x === null || y === null || (w === null) !== (h === null)) {
      return -3;
    }

    const x0 = x - fx;
    const y0 = y - fy;
    // A point hits no pixel of alpha 0, at threshold 0 too; a rect does (Ruffle).
    const least = w === null ? Math.max(1, a1) : a1;
    const x1 = x0 + (w ?? 1);
    const y1 = y0 + (h ?? 1);
    for (let py = Math.max(0, y0); py < Math.min(store.height, y1); py++) {
      for (let px = Math.max(0, x0); px < Math.min(store.width, x1); px++) {
        if (alphaAt(store, px, py) >= least) {
          return true;
        }
      }
    }

    return false;
  });

  // Plain properties, enumerable and writable, as Flash has them (the corpus's bitmapdata_channels).
  constr.define("RED_CHANNEL", 1, 0);
  constr.define("GREEN_CHANNEL", 2, 0);
  constr.define("BLUE_CHANNEL", 4, 0);
  constr.define("ALPHA_CHANNEL", 8, 0);
  // The library's bitmap exported as the name, transparent; undefined where there is none.
  constr.define(
    "loadBitmap",
    realm.method((_, args, v) => {
      const store = args.length > 0 ? host.libraryBitmap(avm1.stringOf(args[0], v)) : null;
      if (store === null) {
        return undefined;
      }

      const o = new avm1.Avm1Object(avm1.get(constr, "prototype", v));
      stores.set(o, store);
      return o;
    }),
    FIXED,
  );
  return constr;
}

/** What a clip's or button's AVM1 object is the face of; null for anything else. */
function displayOf(o: Value): DisplayObject | null {
  const target = o instanceof avm1.Avm1Object ? o.display?.target : undefined;
  return target === undefined ? null : (target as DisplayObject);
}
