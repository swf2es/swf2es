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
import { BitmapStore, pixelRect } from "../../bitmap/bitmap.js";
import { drawDisplayObject } from "../../bitmap/draw.js";
import {
  type ColorTransformValues,
  colorTransform,
  drawBitmap,
  floodFill,
  scroll,
} from "../../bitmap/ops.js";
import type { DisplayObject } from "../../display/display.js";
import type { Drawer } from "../../hosts.js";
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

/** A rectangle's own or inherited x, y, width and height as ints, clipped as Flash clips; null if one is missing. */
function rectOf(o: Value, v: number) {
  if (!(o instanceof avm1.Avm1Object)) {
    return null;
  }

  const names = ["x", "y", "width", "height"];
  if (names.some((n) => !avm1.has(o, n, v))) {
    return null;
  }

  const [x, y, w, h] = names.map((n) => avm1.toNumber(avm1.get(o, n, v), v) | 0);
  return pixelRect(x, y, w, h);
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
    const alpha = storeOf(args[3]);
    // mergeAlpha is false without an alpha bitmap, whatever the documentation says (Ruffle).
    const merge = args.length >= 6 ? avm1.toBoolean(args[5], v) : alpha !== null && !alpha.disposed;
    if (alpha !== null && !alpha.disposed) {
      const [ax, ay] = pointOf(args[4], v);
      store.copyPixels(source, r, dx, dy, merge, alpha, ax, ay);
    } else {
      store.copyPixels(source, r, dx, dy, merge);
    }

    return 0;
  });
  method("draw", 0, (store, args, v) => {
    const m = matrixOf(args[1], v);
    const c = colorOf(args[2]);
    const blend = args.length > 3 && args[3] !== undefined ? avm1.stringOf(args[3], v) : "normal";
    const clip = args.length > 4 ? rectOf(args[4], v) : null;
    const smooth = args.length > 5 && avm1.toBoolean(args[5], v);
    const source = storeOf(args[0]);
    if (source !== null) {
      if (source.disposed) {
        return -3;
      }

      drawBitmap(store, source, m, c, blend, clip, smooth);
      return undefined;
    }

    const d = displayOf(args[0]);
    if (d === null) {
      return -2;
    }

    // Without a renderer nothing is drawn: there is no other way to draw a display object.
    if (host.drawer !== null) {
      drawDisplayObject(host.drawer, store, d, m, c, blend, clip, samplesOf(host.quality));
    }

    return undefined;
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
  method("floodFill", 3, (store, args, v) => {
    floodFill(
      store,
      avm1.toNumber(args[0], v) | 0,
      avm1.toNumber(args[1], v) | 0,
      avm1.toNumber(args[2], v) >>> 0,
    );
    return 1;
  });
  method("scroll", 2, (store, args, v) => {
    scroll(store, avm1.toNumber(args[0], v) | 0, avm1.toNumber(args[1], v) | 0);
    return undefined;
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

  constr.define("RED_CHANNEL", 1, FIXED);
  constr.define("GREEN_CHANNEL", 2, FIXED);
  constr.define("BLUE_CHANNEL", 4, FIXED);
  constr.define("ALPHA_CHANNEL", 8, FIXED);
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
