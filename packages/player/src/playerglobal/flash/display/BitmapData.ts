// flash.display.BitmapData: a pixel store (bitmap.ts) behind the AS3
// object, as $store; the natives read and write it. Flash's limits and its
// ArgumentError 2015 for a size it refuses and for a store disposed.
import { avm2 } from "@swf2es/runtime";
import { BitmapStore, type PixelRect } from "../../../bitmap.js";
import {
  type Affine,
  alphaAt,
  colorBounds,
  colorTransform,
  copyChannel,
  drawBitmap,
  floodFill,
  histogram,
  isThresholdOperation,
  merge,
  noise,
  pixelDissolve,
  scroll,
  threshold,
} from "../../../bitmap-ops.js";
import { bounds } from "../../../bounds.js";
import { transformRect } from "../../../geometry.js";
import { encodePng } from "../../../png.js";
import type { Scripting } from "../../../scripting.js";
import { type BitmapCharacter, INVALID_PIXELS } from "../../../timeline.js";
import { colorOf } from "../geom/Transform.js";

type Value = avm2.Value;
type AsObject = avm2.AsObject;

/** The store of a BitmapData object, or ArgumentError 2015 where it was disposed or never made. */
export function storeOf(s: Scripting, o: AsObject): BitmapStore {
  const store = sizeOf(s, o);
  // A bitmap of 0 by 0 is one Flash could not read from the SWF: it has a size and nothing else.
  if (store.width === 0) {
    throw s.rt.error("ArgumentError", 2015);
  }

  return store;
}

/** The store for reading its size: one Flash could not read has it, a disposed one not. */
function sizeOf(s: Scripting, o: AsObject): BitmapStore {
  const store: BitmapStore | null | undefined = o.$store;
  if (!store || store.disposed) {
    throw s.rt.error("ArgumentError", 2015);
  }

  return store;
}

/** The nearest integer, a half to the even one, as C's rint rounds and Flash's pixel coordinates do. */
function nearest(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d !== 0.5) {
    return d > 0.5 ? f + 1 : f;
  }

  return f % 2 === 0 ? f : f + 1;
}

/** A flash.geom.Rectangle as pixels; TypeError 2007 for null. */
function rectOf(s: Scripting, v: Value): PixelRect {
  if (v === null || v === undefined) {
    throw s.rt.error("TypeError", 2007, "rect");
  }

  // Each edge rounded to the nearest pixel, a half to the even one, as
  // Flash does: a rect from 1.6 of 1.8 fills the pixel at 2 alone, one
  // from 3.5 of 1 fills nothing (Ruffle's bitmapdata_rectangle_rounding).
  const r = v as AsObject;
  const read = (k: string) => s.rt.toNumber(s.rt.getProperty(r, s.rt.publicName(k))) || 0;
  const x0 = nearest(read("x"));
  const y0 = nearest(read("y"));
  const x1 = nearest(read("x") + read("width"));
  const y1 = nearest(read("y") + read("height"));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A flash.geom.Point's values, rounded to pixels; TypeError 2007 for null. */
function pointOf(s: Scripting, v: Value, name: string): [number, number] {
  if (v === null || v === undefined) {
    throw s.rt.error("TypeError", 2007, name);
  }

  const p = v as AsObject;
  const read = (k: string) => nearest(s.rt.toNumber(s.rt.getProperty(p, s.rt.publicName(k))) || 0);
  return [read("x"), read("y")];
}

/** A source BitmapData's store; TypeError 2007 for null. */
function sourceOf(s: Scripting, v: Value): BitmapStore {
  if (v === null || v === undefined) {
    throw s.rt.error("TypeError", 2007, "sourceBitmapData");
  }

  return storeOf(s, v as AsObject);
}

/**
 * draw: a BitmapData, or a Bitmap as its data, its own transform ignored,
 * composited on the CPU (bitmap-ops.ts drawBitmap); any other display
 * object rendered by the Scripting's drawer at `samples` a side, over its
 * own bounds alone, then composited the same way. A null source is
 * ArgumentError 2005, as Flash words it.
 */
function drawInto(
  s: Scripting,
  store: BitmapStore,
  source: Value,
  matrix: Value,
  ct: Value,
  mode: Value,
  clip: Value,
  smoothing: Value,
  samples = 4,
): void {
  if (source === null || source === undefined) {
    throw s.rt.error("ArgumentError", 2005, 0);
  }

  const o = source as AsObject;
  const data: AsObject | null =
    o.$store !== undefined ? o : o.$display?.store !== undefined ? (o.$bitmapData ?? null) : null;
  if (data === null && o.$display === undefined) {
    throw s.rt.error("ArgumentError", 2005, 0);
  }

  const m =
    matrix === null || matrix === undefined
      ? { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
      : matrixOf(s, matrix as AsObject);
  const c = ct === null || ct === undefined ? null : colorOf(s, ct as AsObject);
  const blend = mode === null || mode === undefined ? "normal" : s.rt.toString(mode);
  const r = clip === null || clip === undefined ? null : rectOf(s, clip);
  if (data === null) {
    // Any other display object, through the renderer, then composited as a bitmap is.
    if (!s.drawer) {
      throw s.rt.unsupported("BitmapData#draw of a display object without a renderer");
    }

    // Only the part the object can reach: its bounds through the matrix, a
    // pixel wider for anti-aliasing, within the clip and the bitmap; the
    // snapshot's cost is then the object's size, not the bitmap's.
    const local = bounds(o.$display, true);
    if (!local) {
      return;
    }

    const reach = transformRect(local, m);
    const x0 = Math.max(0, Math.floor(reach.xMin) - 1, r ? r.x : 0);
    const y0 = Math.max(0, Math.floor(reach.yMin) - 1, r ? r.y : 0);
    const x1 = Math.min(store.width, Math.ceil(reach.xMax) + 1, r ? r.x + r.width : store.width);
    const y1 = Math.min(store.height, Math.ceil(reach.yMax) + 1, r ? r.y + r.height : store.height);
    if (x1 <= x0 || y1 <= y0) {
      return;
    }

    const placed = { ...m, tx: m.tx - x0, ty: m.ty - y0 };
    // Plain source over goes on the GPU, the store left there until a script reads it.
    if (
      !c &&
      blend === "normal" &&
      s.drawer.drawInto(store, o.$display, placed, x0, y0, x1 - x0, y1 - y0, samples)
    ) {
      return;
    }

    const drawn = new BitmapStore(x1 - x0, y1 - y0, true, 0);
    drawn.pixels = s.drawer.snapshot(o.$display, placed, x1 - x0, y1 - y0, samples);
    drawBitmap(store, drawn, { a: 1, b: 0, c: 0, d: 1, tx: x0, ty: y0 }, c, blend, r, false);
    return;
  }

  if (data.$bitmapData === null && data.$store === undefined) {
    return;
  }

  // A BitmapData drawn into itself goes a row at a time; through a Bitmap, in scan order.
  drawBitmap(store, storeOf(s, data), m, c, blend, r, !!smoothing, o.$store !== undefined);
}

/** Samples a side of each pixel a display object is rendered at, by drawWithQuality's quality: Flash's 1, 2 and 4. */
function samplesOf(s: Scripting, quality: Value): number {
  if (quality === null || quality === undefined) {
    return 4;
  }

  switch (s.rt.toString(quality).toLowerCase()) {
    case "low":
      return 1;
    case "medium":
      return 2;
    default:
      return 4;
  }
}

/** A flash.geom.Matrix's six values. */
function matrixOf(s: Scripting, o: AsObject): Affine {
  const read = (k: string) => s.rt.toNumber(s.rt.getProperty(o, s.rt.publicName(k)));
  return { a: read("a"), b: read("b"), c: read("c"), d: read("d"), tx: read("tx"), ty: read("ty") };
}

export function bitmapDataNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class BitmapDataNatives {
    declare $store: BitmapStore | null;
    declare $symbol: BitmapCharacter | null;

    "flash.display:BitmapData::ctor"(
      width: Value,
      height: Value,
      transparent: Value,
      fill: Value,
    ): void {
      // A class SymbolClass binds to a bitmap has its pixels, whatever size it asks for.
      const symbol: BitmapCharacter | null = this.$symbol;
      if (symbol) {
        this.$store = BitmapStore.of(symbol.pixels ?? INVALID_PIXELS);
        return;
      }

      // A side under 1 is refused; Flash sets no upper bound any more (16384 wide and 4097 by 4096 both pass).
      const w = s.rt.toInt(width);
      const h = s.rt.toInt(height);
      if (w < 1 || h < 1) {
        throw s.rt.error("ArgumentError", 2015);
      }

      this.$store = new BitmapStore(
        w,
        h,
        transparent === undefined ? true : !!transparent,
        s.rt.toUint(fill === undefined ? 0xffffffff : fill),
      );
    }

    // Disposed, every read throws, the size included, as Flash has it.
    get width(): number {
      return sizeOf(s, this).width;
    }

    get height(): number {
      return sizeOf(s, this).height;
    }

    get transparent(): boolean {
      return sizeOf(s, this).transparent;
    }

    get rect(): Value {
      const store = sizeOf(s, this);
      return s.rt.construct(
        s.rt.classNamed("flash.geom::Rectangle"),
        0,
        0,
        store.width,
        store.height,
      );
    }

    getPixel(x: Value, y: Value): number {
      return storeOf(s, this).getPixel(s.rt.toInt(x), s.rt.toInt(y));
    }

    getPixel32(x: Value, y: Value): number {
      return storeOf(s, this).getPixel32(s.rt.toInt(x), s.rt.toInt(y));
    }

    setPixel(x: Value, y: Value, color: Value): void {
      storeOf(s, this).setPixel(s.rt.toInt(x), s.rt.toInt(y), s.rt.toUint(color));
    }

    setPixel32(x: Value, y: Value, color: Value): void {
      storeOf(s, this).setPixel32(s.rt.toInt(x), s.rt.toInt(y), s.rt.toUint(color));
    }

    fillRect(rect: Value, color: Value): void {
      const store = storeOf(s, this);
      store.fillRect(rectOf(s, rect), s.rt.toUint(color));
    }

    clone(): Value {
      const store = storeOf(s, this);
      const o = s.rt.construct(
        s.rt.classNamed("flash.display::BitmapData"),
        store.width,
        store.height,
        store.transparent,
        0,
      );
      o.$store = store.clone();
      return o;
    }

    dispose(): void {
      const store: BitmapStore | null = this.$store;
      if (store && !store.disposed) {
        store.dispose();
      }
    }

    copyPixels(
      source: Value,
      rect: Value,
      dest: Value,
      alphaBitmap: Value,
      alphaPoint: Value,
      mergeAlpha: Value,
    ): void {
      const store = storeOf(s, this);
      if (source === null || source === undefined) {
        throw s.rt.error("TypeError", 2007, "sourceBitmapData");
      }

      const from = storeOf(s, source as AsObject);
      const r = rectOf(s, rect);
      const [dx, dy] = pointOf(s, dest, "destPoint");
      const alpha =
        alphaBitmap === null || alphaBitmap === undefined
          ? null
          : storeOf(s, alphaBitmap as AsObject);
      const [ax, ay] =
        alphaPoint === null || alphaPoint === undefined
          ? [0, 0]
          : pointOf(s, alphaPoint, "alphaPoint");
      store.copyPixels(from, r, dx, dy, !!mergeAlpha, alpha, ax, ay);
    }

    getPixels(rect: Value): Value {
      const store = storeOf(s, this);
      const o = s.rt.construct(s.rt.classNamed("flash.utils::ByteArray"));
      o.$bytes.write(store.argbBytes(rectOf(s, rect)));
      return o;
    }

    copyPixelsToByteArray(rect: Value, target: Value): void {
      const store = storeOf(s, this);
      if (target === null || target === undefined) {
        throw s.rt.error("TypeError", 2007, "data");
      }

      (target as AsObject).$bytes.write(store.argbBytes(rectOf(s, rect)));
    }

    /**
     * The rect as an image file, written into `byteArray` from its position
     * or into a new one, which is returned: PNG; JPEG and JPEG XR, which
     * Flash also writes, are not supported yet.
     */
    encode(rect: Value, compressor: Value, byteArray: Value): Value {
      const store = storeOf(s, this);
      if (rect === null || rect === undefined) {
        throw s.rt.error("TypeError", 2007, "rectangle");
      }

      if (compressor === null || compressor === undefined) {
        throw s.rt.error("TypeError", 2007, "compressor");
      }

      const options = compressor as AsObject;
      const is = (name: string) => s.rt.isInstance(options, s.rt.classNamed(name));
      if (!is("flash.display::PNGEncoderOptions")) {
        if (is("flash.display::JPEGEncoderOptions") || is("flash.display::JPEGXREncoderOptions")) {
          throw s.rt.unsupported("BitmapData#encode as JPEG");
        }

        throw s.rt.error("ArgumentError", 2004);
      }

      const area = store.clip(rectOf(s, rect));
      if (!area) {
        throw s.rt.error("ArgumentError", 2006);
      }

      const fast = !!s.rt.getProperty(options, s.rt.publicName("fastCompression"));
      const out =
        byteArray === null || byteArray === undefined
          ? (s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")) as AsObject)
          : (byteArray as AsObject);
      out.$bytes.write(encodePng(store, area, fast));
      return out;
    }

    setPixels(rect: Value, input: Value): void {
      const store = storeOf(s, this);
      // The parameters checked in order: the rect's null before the input's.
      const r = rectOf(s, rect);
      if (input === null || input === undefined) {
        throw s.rt.error("TypeError", 2007, "inputByteArray");
      }

      const c = store.clip(r);
      if (!c) {
        return;
      }

      // A pixel at a time, as Flash reads them: those read before the end are set, then EOFError 2030.
      const bytes = (input as AsObject).$bytes;
      const values: number[] = [];
      try {
        for (let i = 0; i < c.width * c.height; i++) {
          const b: Uint8Array = bytes.read(4);
          values.push(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
        }
      } finally {
        store.setVector(c, values);
      }
    }

    getVector(rect: Value): Value {
      const store = storeOf(s, this);
      const cls = s.rt.resolve(s.rt.vector("uint"));
      const o = cls.$it.instance();
      o.$a = store.getVector(rectOf(s, rect));
      return o;
    }

    setVector(rect: Value, input: Value): void {
      const store = storeOf(s, this);
      const r = rectOf(s, rect);
      if (input === null || input === undefined) {
        throw s.rt.error("TypeError", 2007, "imputVector");
      }

      const c = store.clip(r);
      if (!c) {
        return;
      }

      const values: number[] = (input as AsObject).$a;
      if (values.length < c.width * c.height) {
        throw s.rt.error("RangeError", 2006);
      }

      store.setVector(c, values);
    }

    noise(seed: Value, low: Value, high: Value, channels: Value, gray: Value): void {
      noise(
        storeOf(s, this),
        s.rt.toInt(seed),
        low === undefined ? 0 : s.rt.toUint(low),
        high === undefined ? 255 : s.rt.toUint(high),
        channels === undefined ? 7 : s.rt.toUint(channels),
        !!gray,
      );
    }

    copyChannel(source: Value, rect: Value, dest: Value, from: Value, to: Value): void {
      const store = storeOf(s, this);
      const src = sourceOf(s, source);
      const r = rectOf(s, rect);
      const [dx, dy] = pointOf(s, dest, "destPoint");
      copyChannel(store, src, r, dx, dy, s.rt.toUint(from), s.rt.toUint(to));
    }

    colorTransform(rect: Value, ct: Value): void {
      const store = storeOf(s, this);
      const r = rectOf(s, rect);
      if (ct === null || ct === undefined) {
        throw s.rt.error("TypeError", 2007, "colorTransform");
      }

      colorTransform(store, r, colorOf(s, ct as AsObject));
    }

    merge(
      source: Value,
      rect: Value,
      dest: Value,
      rMul: Value,
      gMul: Value,
      bMul: Value,
      aMul: Value,
    ): void {
      const store = storeOf(s, this);
      const src = sourceOf(s, source);
      const r = rectOf(s, rect);
      const [dx, dy] = pointOf(s, dest, "destPoint");
      merge(
        store,
        src,
        r,
        dx,
        dy,
        [rMul, gMul, bMul, aMul].map((m) => s.rt.toUint(m)) as [number, number, number, number],
      );
    }

    scroll(x: Value, y: Value): void {
      scroll(storeOf(s, this), s.rt.toInt(x), s.rt.toInt(y));
    }

    threshold(
      source: Value,
      rect: Value,
      dest: Value,
      op: Value,
      value: Value,
      color: Value,
      mask: Value,
      copySource: Value,
    ): number {
      const store = storeOf(s, this);
      const src = sourceOf(s, source);
      const r = rectOf(s, rect);
      const [dx, dy] = pointOf(s, dest, "destPoint");
      // A String parameter: undefined is null, refused with 2007 before the value is looked at.
      if (op === null || op === undefined) {
        throw s.rt.error("TypeError", 2007, "operation");
      }

      const operation = s.rt.toString(op);
      if (!isThresholdOperation(operation)) {
        throw s.rt.error("ArgumentError", 2005, 3);
      }

      return threshold(
        store,
        src,
        r,
        dx,
        dy,
        operation,
        s.rt.toUint(value),
        s.rt.toUint(color),
        mask === undefined ? 0xffffffff : s.rt.toUint(mask),
        !!copySource,
      );
    }

    getColorBoundsRect(mask: Value, color: Value, find: Value): Value {
      const r = colorBounds(
        storeOf(s, this),
        s.rt.toUint(mask),
        s.rt.toUint(color),
        find === undefined ? true : !!find,
      );
      return s.rt.construct(s.rt.classNamed("flash.geom::Rectangle"), r.x, r.y, r.width, r.height);
    }

    floodFill(x: Value, y: Value, color: Value): void {
      floodFill(storeOf(s, this), s.rt.toInt(x), s.rt.toInt(y), s.rt.toUint(color));
    }

    histogram(rect: Value): Value {
      const store = storeOf(s, this);
      const counts = histogram(
        store,
        rect === null || rect === undefined
          ? { x: 0, y: 0, width: store.width, height: store.height }
          : rectOf(s, rect),
      );
      const inner = s.rt.resolve(s.rt.vector("Number"));
      const outer = s.rt.applyType(s.rt.classNamed("__AS3__.vec::Vector"), [inner]);
      const o = outer.$it.instance();
      o.$a = counts.map((c) => {
        const v = inner.$it.instance();
        v.$a = c;
        return v;
      });
      return o;
    }

    hitTest(
      firstPoint: Value,
      firstAlpha: Value,
      second: Value,
      secondPoint: Value,
      secondAlpha: Value,
    ): boolean {
      const store = storeOf(s, this);
      const [fx, fy] = pointOf(s, firstPoint, "firstPoint");
      const a1 = s.rt.toUint(firstAlpha);
      const other = second as AsObject;
      if (other === null || other === undefined) {
        throw s.rt.error("ArgumentError", 2005, 2);
      }

      const name = s.rt.traitsOf(other).name;
      // A Bitmap tests as its BitmapData.
      const data: AsObject | null =
        other.$store !== undefined
          ? other
          : other.$display?.store !== undefined
            ? (other.$bitmapData ?? null)
            : null;
      const isPoint = name === "flash.geom::Point";
      const isRect = name === "flash.geom::Rectangle";
      if (isPoint || isRect) {
        const read = (k: string) => s.rt.toNumber(s.rt.getProperty(other, s.rt.publicName(k))) || 0;
        const x0 = Math.trunc(read("x")) - fx;
        const y0 = Math.trunc(read("y")) - fy;
        const w = isRect ? Math.trunc(read("width")) : 1;
        const h = isRect ? Math.trunc(read("height")) : 1;
        for (let y = Math.max(0, y0); y < Math.min(store.height, y0 + h); y++) {
          for (let x = Math.max(0, x0); x < Math.min(store.width, x0 + w); x++) {
            // A point or rect hits no pixel of alpha 0, at threshold 0 too (bitmapdata_hittest_threshold).
            const a = alphaAt(store, x, y);
            if (a > 0 && a >= a1) {
              return true;
            }
          }
        }

        return false;
      }

      if (data) {
        const second = storeOf(s, data);
        // Against a bitmap, its point is required.
        const [sx, sy] = pointOf(s, secondPoint, "secondBitmapDataPoint");
        const a2 = secondAlpha === undefined ? 1 : s.rt.toUint(secondAlpha);
        const ox = sx - fx;
        const oy = sy - fy;
        for (let y = Math.max(0, oy); y < Math.min(store.height, oy + second.height); y++) {
          for (let x = Math.max(0, ox); x < Math.min(store.width, ox + second.width); x++) {
            if (alphaAt(store, x, y) >= a1 && alphaAt(second, x - ox, y - oy) >= a2) {
              return true;
            }
          }
        }

        return false;
      }

      throw s.rt.error("ArgumentError", 2005, 2);
    }

    pixelDissolve(
      source: Value,
      rect: Value,
      dest: Value,
      seed: Value,
      count: Value,
      fill: Value,
    ): number {
      const store = storeOf(s, this);
      // Anything but a BitmapData is refused as null, as Flash words it.
      if (source === null || source === undefined || (source as AsObject).$store === undefined) {
        throw s.rt.error("TypeError", 2007, "sourceBitmapData");
      }

      const src = storeOf(s, source as AsObject);
      if (rect === null || rect === undefined) {
        throw s.rt.error("TypeError", 2007, "sourceRect");
      }

      const r = rectOf(s, rect);
      const [dx, dy] = pointOf(s, dest, "destPoint");
      const n = count === undefined ? 0 : s.rt.toInt(count);
      if (n < 0) {
        throw s.rt.error("RangeError", 2027, "numPixels", n);
      }

      return pixelDissolve(
        store,
        src,
        r,
        dx,
        dy,
        seed === undefined ? 0 : s.rt.toNumber(seed),
        n,
        fill === undefined ? 0 : s.rt.toUint(fill),
      );
    }

    draw(
      source: Value,
      matrix: Value,
      ct: Value,
      mode: Value,
      clip: Value,
      smoothing: Value,
    ): void {
      drawInto(s, storeOf(s, this), source, matrix, ct, mode, clip, smoothing);
    }

    drawWithQuality(
      source: Value,
      matrix: Value,
      ct: Value,
      mode: Value,
      clip: Value,
      smoothing: Value,
      quality: Value,
    ): void {
      drawInto(
        s,
        storeOf(s, this),
        source,
        matrix,
        ct,
        mode,
        clip,
        smoothing,
        samplesOf(s, quality),
      );
    }

    lock(): void {
      storeOf(s, this);
    }

    unlock(): void {
      storeOf(s, this);
    }
  }

  avm2.registerNativeClass(natives, "flash.display::BitmapData", BitmapDataNatives);
  return natives;
}

export function bitmapDataHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return {
    "flash.display::BitmapData": {
      create: (traits) => {
        const o = Object.create(traits.proto);
        o.$store = null;
        o.$symbol = s.bitmapSymbol(traits);
        return o;
      },
    },
  };
}
