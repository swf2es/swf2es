// Asset IDs belong to a library, not a process: independently loaded SWFs
// routinely define different shapes and fonts with the same character IDs.
import { type Font, type Glyph, readSwf } from "../../../packages/format/dist/index.js";
import {
  type Character,
  type Library,
  readLibrary,
} from "../../../packages/player/dist/display/timeline.js";

export interface AssetRef {
  library: number;
  character: number;
}

export interface SharedLibrary {
  swf: SharedArrayBuffer;
  bitmaps: {
    id: number;
    width: number;
    height: number;
    transparent: boolean;
    pixels: SharedArrayBuffer;
  }[];
}

function shared(bytes: Uint8Array): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** Publish once after linking/decoding. Neither side writes these asset buffers. */
export function shareLibrary(bytes: Uint8Array, library: Library): SharedLibrary {
  const bitmaps: SharedLibrary["bitmaps"] = [];
  for (const c of library.characters.values()) {
    if (c.type !== "bitmap") {
      continue;
    }

    if (!c.pixels) {
      throw new Error("worker library needs decoded bitmap assets");
    }

    const p = c.pixels;
    bitmaps.push({
      id: c.id,
      width: p.width,
      height: p.height,
      transparent: p.transparent,
      pixels: shared(new Uint8Array(p.pixels.buffer, p.pixels.byteOffset, p.pixels.byteLength)),
    });
  }

  return { swf: shared(bytes), bitmaps };
}

export function readSharedLibrary(asset: SharedLibrary): Library {
  if (!(asset.swf instanceof SharedArrayBuffer)) {
    throw new Error("invalid shared worker library");
  }

  const library = readLibrary(readSwf(new Uint8Array(asset.swf)));
  const seen = new Set<number>();
  for (const p of asset.bitmaps) {
    const c = library.characters.get(p.id);
    if (
      c?.type !== "bitmap" ||
      seen.has(p.id) ||
      !Number.isSafeInteger(p.width) ||
      p.width < 0 ||
      !Number.isSafeInteger(p.height) ||
      p.height < 0 ||
      typeof p.transparent !== "boolean" ||
      !(p.pixels instanceof SharedArrayBuffer) ||
      p.width * p.height * 4 !== p.pixels.byteLength
    ) {
      throw new Error("invalid shared worker bitmap asset");
    }

    c.pixels = {
      width: p.width,
      height: p.height,
      transparent: p.transparent,
      pixels: new Uint32Array(p.pixels),
    };
    seen.add(p.id);
  }

  for (const c of library.characters.values()) {
    if (c.type === "bitmap" && !seen.has(c.id)) {
      throw new Error("missing shared worker bitmap asset");
    }
  }

  return library;
}

export class SceneLibraries {
  private readonly libraries = new Map<number, Library>();
  private readonly used = new Set<number>();
  private readonly references = new WeakMap<object, AssetRef[]>();
  private readonly glyphs = new WeakMap<Glyph, number>();

  add(id: number, library: Library): void {
    if (!Number.isSafeInteger(id) || id <= 0 || this.used.has(id)) {
      throw new Error("worker library IDs must be positive and never reused");
    }

    this.used.add(id);
    this.libraries.set(id, library);
    for (const [character, c] of library.characters) {
      const ref = { library: id, character };
      this.index(c, ref);
      if (c.type === "font") {
        this.index(c.font, ref);
        c.font.glyphs.forEach((g, index) => {
          this.glyphs.set(g, index);
        });
      }
    }
  }

  private index(asset: object, ref: AssetRef): void {
    const refs = this.references.get(asset);
    if (refs) {
      refs.push(ref);
    } else {
      this.references.set(asset, [ref]);
    }
  }

  /** Retire only after every frame referencing this library has been released. */
  drop(id: number): void {
    const library = this.libraries.get(id);
    if (library) {
      for (const c of library.characters.values()) {
        for (const asset of c.type === "font" ? [c, c.font] : [c]) {
          const refs = this.references.get(asset)?.filter((ref) => ref.library !== id);
          if (refs?.length) {
            this.references.set(asset, refs);
          } else {
            this.references.delete(asset);
          }
        }
      }
    }

    this.libraries.delete(id);
  }

  ref(asset: object): AssetRef {
    const ref = this.references.get(asset)?.find((ref) => {
      const c = this.character(ref.library, ref.character);
      return ref.character > 0 && (c === asset || (c?.type === "font" && c.font === asset));
    });
    if (!ref || !this.libraries.has(ref.library)) {
      throw new Error("worker scene needs a registered library asset");
    }

    return ref;
  }

  character(library: number, id: number): Character | undefined {
    return this.libraries.get(library)?.characters.get(id);
  }

  library(id: number): Library | undefined {
    return this.libraries.get(id);
  }

  font(library: number, id: number): Font {
    const c = this.character(library, id);
    if (c?.type !== "font") {
      throw new Error("invalid worker scene font");
    }

    return c.font;
  }

  glyph(font: Font, glyph: Glyph): number {
    const index = this.glyphs.get(glyph);
    if (index === undefined || font.glyphs[index] !== glyph) {
      throw new Error("worker scene needs a registered font glyph");
    }

    return index;
  }
}

export function sceneLibraries(source: Library | SceneLibraries): SceneLibraries {
  if (source instanceof SceneLibraries) {
    return source;
  }

  const assets = new SceneLibraries();
  assets.add(1, source);
  return assets;
}
