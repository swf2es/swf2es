import {
  DRAW,
  type Geometries,
  type GeometryData,
  type GeometryHandle,
  LAYER_BEGIN,
  LAYER_END,
  MASK_BEGIN,
  MASK_POP,
} from "@swf2es/render";
import type { WebGLBackend } from "@swf2es/render/webgl";
import { GeometryBuilder } from "./geometry.ts";
import { outlineOf } from "./outline.ts";

interface Cached {
  source: GeometryData;
  pixel: number;
  handle: GeometryHandle | null;
  frame: number;
}

/** Opt-in diagnostic adapter. Install the coverage shader before constructing the backend. */
export class CoveragePreview {
  enabled = false;
  highlight = false;
  readonly counts = { applied: 0, built: 0, cached: 0, refused: 0 };
  private readonly builder: GeometryBuilder;
  private readonly original: WebGLBackend["execute"];
  private readonly originalDestroy: WebGLBackend["destroy"];
  private readonly cache = new Map<number, Cached>();
  private outlines = new WeakMap<GeometryData, number[] | null>();
  private swaps = new Int32Array(2048);
  private registry: Geometries | null = null;
  private lastHighlight = false;
  private readonly backend: WebGLBackend;

  constructor(backend: WebGLBackend, instance: WebAssembly.Instance) {
    this.backend = backend;
    this.builder = new GeometryBuilder(instance);
    this.original = backend.execute;
    this.originalDestroy = backend.destroy;
    backend.execute = (...args) => this.execute(args);
    backend.destroy = () => {
      this.clear();
      this.builder.dispose();
      backend.execute = this.original;
      backend.destroy = this.originalDestroy;
      this.originalDestroy.call(backend);
    };
  }

  clear(): void {
    for (const entry of this.cache.values()) {
      if (entry.handle && this.registry?.alive(entry.handle)) {
        this.registry.remove(entry.handle.id);
      }
    }
    this.cache.clear();
    this.counts.cached = 0;
  }

  private execute(args: Parameters<WebGLBackend["execute"]>): void {
    const [, scene, rows, geometries, , , , target, root] = args;
    this.registry = geometries;
    this.counts.applied = this.counts.built = this.counts.refused = 0;
    if (!this.enabled || root) {
      if (!this.enabled) {
        this.clear();
      }
      this.original.apply(this.backend, args);
      return;
    }
    if (this.highlight !== this.lastHighlight) {
      this.clear();
      this.lastHighlight = this.highlight;
    }
    for (const id of geometries.updated) {
      const data = geometries.get(id);
      if (data) {
        this.outlines.delete(data);
      }
      this.drop(id);
    }
    for (const [id, entry] of this.cache) {
      if (
        geometries.get(id) !== entry.source ||
        geometries.frame - entry.frame > 120 ||
        (entry.handle && !geometries.alive(entry.handle))
      ) {
        this.drop(id);
      }
    }
    let changed = 0,
      masks = 0,
      layers = 0,
      attempts = 0;
    try {
      for (let i = 0; i < scene.length; i++) {
        switch (scene.kind[i]) {
          case MASK_BEGIN:
            masks++;
            continue;
          case MASK_POP:
            masks--;
            continue;
          case LAYER_BEGIN:
            layers++;
            continue;
          case LAYER_END:
            layers--;
            continue;
          case DRAW:
            break;
          default:
            continue;
        }
        if (masks || layers || scene.texture[i] >= 0 || scene.sampler[i] || scene.blend[i]) {
          continue;
        }
        const at = scene.row[i] * 16;
        if (rows.data[at + 11] !== 1 || rows.data[at + 15] !== 0) {
          continue;
        }
        const a = rows.data[at],
          b = rows.data[at + 1],
          c = rows.data[at + 2],
          d = rows.data[at + 3];
        const sx = Math.hypot(a, b),
          sy = Math.hypot(c, d);
        if (
          sx < 1e-6 ||
          Math.abs(sx - sy) > sx * 1e-5 ||
          Math.abs(a * c + b * d) > sx * sy * 1e-5
        ) {
          continue;
        }
        const pixel = 1 / (sx * target.scale);
        if (!Number.isFinite(pixel) || pixel < 1e-5 || pixel > 1e5) {
          continue;
        }
        const id = scene.geometry[i],
          source = geometries.get(id);
        if (!source) {
          continue;
        }
        let entry = this.cache.get(id);
        if (entry && Math.abs(entry.pixel - pixel) > pixel * 1e-6) {
          // A second placement in this frame still names its old variant.
          if (entry.frame === geometries.frame) {
            continue;
          }
          this.drop(id);
          entry = undefined;
        }
        if (!entry) {
          if (attempts >= 16) {
            continue;
          }
          let contour = this.outlines.get(source);
          if (contour === undefined) {
            attempts++;
            contour = outlineOf(source);
            this.outlines.set(source, contour);
          }
          if (!contour) {
            continue;
          }
          if (this.cache.size >= 128) {
            for (const [key, old] of this.cache) {
              if (old.frame < geometries.frame) {
                this.drop(key);
                break;
              }
            }
            if (this.cache.size >= 128) {
              continue;
            }
          }
          attempts++;
          const made = this.builder.coverage(
            contour,
            pixel,
            this.highlight ? 0xffff00ff : source.colors[0],
          );
          const handle = made ? geometries.add(made) : null;
          entry = { source, pixel, handle, frame: geometries.frame };
          this.cache.set(id, entry);
          this.counts.built++;
        }
        entry.frame = geometries.frame;
        if (!entry.handle) {
          this.counts.refused++;
          continue;
        }
        if (changed + 2 > this.swaps.length) {
          const grown = new Int32Array(this.swaps.length * 2);
          grown.set(this.swaps);
          this.swaps = grown;
        }
        this.swaps[changed++] = i;
        this.swaps[changed++] = id;
        scene.geometry[i] = entry.handle.id;
        geometries.use(entry.handle.id);
        this.counts.applied++;
      }
      this.counts.cached = this.cache.size;
      this.original.apply(this.backend, args);
    } finally {
      for (let i = 0; i < changed; i += 2) {
        scene.geometry[this.swaps[i]] = this.swaps[i + 1];
      }
    }
  }

  private drop(id: number): void {
    const entry = this.cache.get(id);
    if (entry?.handle && this.registry?.alive(entry.handle)) {
      this.registry.remove(entry.handle.id);
    }
    this.cache.delete(id);
  }
}
