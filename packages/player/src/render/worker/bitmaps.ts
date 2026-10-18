// Every complete frame owns its pixels, including unchanged stores. A dropped
// presentation therefore cannot drop an update the next frame depends on.
import { BitmapStore } from "../../bitmap/bitmap.js";
import type { BitmapObject } from "../../display/bitmapobject.js";
import { CONTENT } from "../../display/displayobject.js";
import { ValuesReader, ValuesWriter } from "./values.js";

const SNAPPING = ["auto", "always", "never"];
export interface BitmapRecord {
  smoothing: boolean;
  snapping: string;
  pixels: BitmapPixels | null;
}
export interface BitmapPixels {
  id: number;
  version: number;
  width: number;
  height: number;
  transparent: boolean;
  pixels: Uint32Array;
}

export class BitmapSnapshot {
  private readonly ids = new WeakMap<BitmapStore, number>();
  private readonly offsets = new Map<BitmapStore, number>();
  private next = 0;

  clear(): void {
    this.offsets.clear();
  }

  write(o: BitmapObject, data: Float64Array, at: number): number {
    const w = new ValuesWriter(data, at);
    const snapping = SNAPPING.indexOf(o.pixelSnapping);
    if (snapping < 0) {
      throw new Error("invalid worker bitmap pixelSnapping");
    }

    w.number(Number(o.smoothing));
    w.number(snapping);
    return this.writeStore(o.store, data, w.at);
  }

  writeStore(store: BitmapStore | null, data: Float64Array, at: number): number {
    const w = new ValuesWriter(data, at);
    if (!store || store.disposed) {
      w.number(0);
      return w.at;
    }

    let id = this.ids.get(store);
    if (id === undefined) {
      id = ++this.next;
      this.ids.set(store, id);
    }

    w.number(id);
    const offset = this.offsets.get(store);
    w.number(offset ?? w.at + 1);
    if (offset !== undefined) {
      return w.at;
    }

    this.offsets.set(store, w.at);
    w.number(store.version);
    w.number(store.width);
    w.number(store.height);
    w.number(Number(store.transparent));
    // readable brings a synchronous main-thread draw back before publication.
    const pixels = store.readable;
    const size = Math.ceil(pixels.length / 2);
    if (w.at + size > data.length) {
      throw new RangeError("scene snapshot exceeds its slot capacity");
    }

    const target = new Uint32Array(data.buffer, data.byteOffset + w.at * 8, size * 2);
    target.fill(0);
    target.set(pixels);
    return w.at + size;
  }
}

export class BitmapRecords {
  private readonly records = new Map<number, { offset: number; value: BitmapPixels }>();

  read(data: Float64Array, at: number): { record: BitmapRecord; end: number } {
    const r = new ValuesReader(data, at);
    const smoothing = r.boolean();
    const snapping = SNAPPING[r.integer(0, SNAPPING.length - 1)];
    const decoded = this.readStore(data, r.at);
    return { record: { smoothing, snapping, pixels: decoded.pixels }, end: decoded.end };
  }

  readStore(data: Float64Array, at: number): { pixels: BitmapPixels | null; end: number } {
    const r = new ValuesReader(data, at);
    const id = r.integer(0, Number.MAX_SAFE_INTEGER);
    if (id === 0) {
      return { pixels: null, end: r.at };
    }

    const offset = r.integer(0, data.length);
    const previous = this.records.get(id);
    if (previous) {
      if (offset !== previous.offset) {
        throw new Error("invalid scene snapshot bitmap reference");
      }

      return { pixels: previous.value, end: r.at };
    }

    if (offset !== r.at) {
      throw new Error("missing scene snapshot bitmap pixels");
    }

    const version = r.integer(0, Number.MAX_SAFE_INTEGER);
    const width = r.integer(0, 0x7fffffff);
    const height = r.integer(0, 0x7fffffff);
    const transparent = r.boolean();
    const count = width * height;
    const size = Math.ceil(count / 2);
    if (!Number.isSafeInteger(count) || r.at + size > data.length) {
      throw new Error("truncated scene snapshot bitmap pixels");
    }

    const pixels = new Uint32Array(data.buffer, data.byteOffset + r.at * 8, count);
    const value = { id, version, width, height, transparent, pixels };
    this.records.set(id, { offset, value });
    return { pixels: value, end: r.at + size };
  }
}

export class BitmapMirror {
  private readonly stores = new Map<number, { store: BitmapStore; version: number }>();
  private readonly seen = new Set<number>();

  begin(): void {
    this.seen.clear();
  }

  apply(o: BitmapObject, record: BitmapRecord): void {
    const store = this.store(record.pixels);
    if (o.store !== store) {
      o.store = store;
    }
    if (o.smoothing !== record.smoothing || o.pixelSnapping !== record.snapping) {
      o.smoothing = record.smoothing;
      o.pixelSnapping = record.snapping;
      o.invalidate(CONTENT);
    }
  }

  store(p: BitmapPixels | null): BitmapStore | null {
    let store: BitmapStore | null = null;
    if (p) {
      this.seen.add(p.id);
      let entry = this.stores.get(p.id);
      if (
        entry &&
        (entry.store.width !== p.width ||
          entry.store.height !== p.height ||
          entry.store.transparent !== p.transparent)
      ) {
        entry.store.dispose();
        this.stores.delete(p.id);
        entry = undefined;
      }

      if (!entry) {
        entry = { store: new BitmapStore(p.width, p.height, p.transparent, 0), version: -1 };
        this.stores.set(p.id, entry);
      }

      store = entry.store;
      if (entry.version !== p.version) {
        store.pixels = p.pixels.slice();
        store.changed();
        entry.version = p.version;
      }
    }

    return store;
  }

  finish(): void {
    for (const [id, entry] of this.stores) {
      if (!this.seen.has(id)) {
        entry.store.dispose();
        this.stores.delete(id);
      }
    }
  }
}
