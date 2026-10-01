// flash.display.BitmapData: a pixel store (bitmap.ts) behind the AS3
// object, as $store; the natives read and write it. Flash's limits and its
// ArgumentError 2015 for a size it refuses and for a store disposed.
import { avm2 } from "@swf2es/runtime";
import { BitmapStore, type PixelRect } from "../../../bitmap.js";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;
type AsObject = avm2.AsObject;

/** The store of a BitmapData object, or ArgumentError 2015 where it was disposed or never made. */
export function storeOf(s: Scripting, o: AsObject): BitmapStore {
  const store: BitmapStore | null | undefined = o.$store;
  if (!store || store.disposed) {
    throw s.rt.error("ArgumentError", 2015);
  }

  return store;
}

/** A flash.geom.Rectangle's values, rounded to pixels as Flash takes them; null for a null rectangle (TypeError 2007). */
function rectOf(s: Scripting, v: Value): PixelRect {
  if (v === null || v === undefined) {
    throw s.rt.error("TypeError", 2007, "rect");
  }

  const r = v as AsObject;
  const read = (k: string) =>
    Math.trunc(s.rt.toNumber(s.rt.getProperty(r, s.rt.publicName(k))) || 0);
  return { x: read("x"), y: read("y"), width: read("width"), height: read("height") };
}

/** A flash.geom.Point's values, rounded to pixels; TypeError 2007 for null. */
function pointOf(s: Scripting, v: Value, name: string): [number, number] {
  if (v === null || v === undefined) {
    throw s.rt.error("TypeError", 2007, name);
  }

  const p = v as AsObject;
  const read = (k: string) =>
    Math.trunc(s.rt.toNumber(s.rt.getProperty(p, s.rt.publicName(k))) || 0);
  return [read("x"), read("y")];
}

/** Pixels as the big-endian ARGB bytes getPixels writes. */
function argbBytes(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setUint32(i * 4, values[i]);
  }

  return bytes;
}

export function bitmapDataNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class BitmapDataNatives {
    declare $store: BitmapStore | null;

    "flash.display:BitmapData::ctor"(
      width: Value,
      height: Value,
      transparent: Value,
      fill: Value,
    ): void {
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
      return storeOf(s, this).width;
    }

    get height(): number {
      return storeOf(s, this).height;
    }

    get transparent(): boolean {
      return storeOf(s, this).transparent;
    }

    get rect(): Value {
      const store = storeOf(s, this);
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
      _alphaBitmap: Value,
      _alphaPoint: Value,
      mergeAlpha: Value,
    ): void {
      const store = storeOf(s, this);
      if (source === null || source === undefined) {
        throw s.rt.error("TypeError", 2007, "sourceBitmapData");
      }

      const from = storeOf(s, source as AsObject);
      const [dx, dy] = pointOf(s, dest, "destPoint");
      store.copyPixels(from, rectOf(s, rect), dx, dy, !!mergeAlpha);
    }

    getPixels(rect: Value): Value {
      const store = storeOf(s, this);
      const o = s.rt.construct(s.rt.classNamed("flash.utils::ByteArray"));
      o.$bytes.write(argbBytes(store.getVector(rectOf(s, rect))));
      return o;
    }

    copyPixelsToByteArray(rect: Value, target: Value): void {
      const store = storeOf(s, this);
      if (target === null || target === undefined) {
        throw s.rt.error("TypeError", 2007, "data");
      }

      (target as AsObject).$bytes.write(argbBytes(store.getVector(rectOf(s, rect))));
    }

    setPixels(rect: Value, input: Value): void {
      const store = storeOf(s, this);
      if (input === null || input === undefined) {
        throw s.rt.error("TypeError", 2007, "inputByteArray");
      }

      const r = rectOf(s, rect);
      const c = store.clip(r);
      if (!c) {
        return;
      }

      // Read as the rect is clipped, so a short ByteArray fails as Flash's does (EOFError).
      const bytes: Uint8Array = (input as AsObject).$bytes.read(c.width * c.height * 4);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const values: number[] = [];
      for (let i = 0; i < c.width * c.height; i++) {
        values.push(view.getUint32(i * 4));
      }

      store.setVector(c, values);
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
      if (input === null || input === undefined) {
        throw s.rt.error("TypeError", 2007, "inputVector");
      }

      const r = rectOf(s, rect);
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

export const bitmapDataHooks: Record<string, avm2.ClassHook> = {
  "flash.display::BitmapData": {
    create: (traits) => {
      const o = Object.create(traits.proto);
      o.$store = null;
      return o;
    },
  },
};
