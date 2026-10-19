// Resolved Graphics layers, rather than commands: open paths and Flash's
// closing strokes must draw exactly as the main thread currently records them.
import type { Line, Matrix } from "../../../packages/format/dist/index.js";
import { BitmapStore } from "../../../packages/player/dist/bitmap/bitmap.js";
import type { DisplayObject } from "../../../packages/player/dist/display/displayobject.js";
import { Drawing } from "../../../packages/player/dist/display/drawing.js";
import type {
  ImageFill,
  Paint,
  Path,
  ShapeLayer,
  TriangleMesh,
} from "../../../packages/player/dist/display/shapes.js";
import type { BitmapMirror, BitmapPixels, BitmapRecords, BitmapSnapshot } from "./bitmaps.ts";
import type { SceneLibraries } from "./libraries.ts";
import { ValuesReader, ValuesWriter } from "./values.ts";

const TYPES = ["solid", "linear", "radial", "focal", "bitmap", "gradient", "image"] as const;
const MATRIX = ["a", "b", "c", "d", "tx", "ty"] as const;
const LINE_NUMBERS = ["width", "color", "startCap", "endCap", "join", "miterLimit"] as const;
const LINE_BOOLEANS = ["noHScale", "noVScale", "pixelHinting", "noClose"] as const;
interface ImageBinding {
  target: ImageFill | TriangleMesh;
  pixels: BitmapPixels | null;
}
export interface DrawingRecord {
  drawing: Drawing;
  images: ImageBinding[];
}

class DrawingWriter extends ValuesWriter {
  readonly assets: SceneLibraries;
  readonly bitmaps: BitmapSnapshot;

  constructor(data: Float64Array, at: number, assets: SceneLibraries, bitmaps: BitmapSnapshot) {
    super(data, at);
    this.assets = assets;
    this.bitmaps = bitmaps;
  }

  matrix(m: Matrix): void {
    for (let i = 0; i < MATRIX.length; i++) {
      this.number(m[MATRIX[i]]);
    }
  }

  numbers(values: ArrayLike<number>): void {
    this.number(values.length);
    for (let i = 0; i < values.length; i++) {
      this.number(values[i]);
    }
  }

  paths(paths: Path[]): void {
    this.number(paths.length);
    for (let i = 0; i < paths.length; i++) {
      this.numbers(paths[i]);
    }
  }

  paint(fill: Paint): void {
    const kind = TYPES.indexOf(fill.type);
    if (kind < 0) {
      throw new Error("unsupported worker drawing fill");
    }

    this.number(kind);
    switch (fill.type) {
      case "solid":
        this.number(fill.color);
        break;
      case "image":
        this.number(Number(fill.image instanceof BitmapStore));
        if (fill.image instanceof BitmapStore) {
          this.at = this.bitmaps.writeStore(fill.image, this.data, this.at);
        } else {
          if (!fill.image.pixels || fill.image.store?.version || fill.image.store?.disposed) {
            throw new Error("worker drawing needs immutable library bitmap fills");
          }

          const ref = this.assets.ref(fill.image);
          this.number(ref.library);
          this.number(ref.character);
        }

        this.matrix(fill.matrix);
        this.number(Number(fill.repeat));
        this.number(Number(fill.smooth));
        break;
      case "bitmap":
        this.number(fill.bitmap);
        this.matrix(fill.matrix);
        this.number(Number(fill.repeat));
        this.number(Number(fill.smooth));
        break;
      case "linear":
      case "radial":
      case "focal":
      case "gradient": {
        const g = fill.type === "gradient" ? fill : fill.gradient;
        this.matrix(g.matrix);
        this.number(g.spread);
        this.number(
          fill.type === "gradient" ? Number(fill.linearRgb) : fill.gradient.interpolation,
        );
        this.number(g.focal);
        this.number(fill.type === "gradient" ? Number(fill.radial) : 0);
        this.number(g.stops.length);
        for (let i = 0; i < g.stops.length; i++) {
          this.number(g.stops[i].ratio);
          this.number(g.stops[i].color);
        }
        break;
      }
    }
  }

  layer(layer: ShapeLayer, mirrored = false): void {
    this.number(layer.fills.length);
    for (let i = 0; i < layer.fills.length; i++) {
      const f = layer.fills[i];
      this.paint(f.fill);
      this.number(f.winding === "evenOdd" ? 0 : 1);
      this.paths(f.contours);
    }

    this.number(layer.strokes.length);
    for (let i = 0; i < layer.strokes.length; i++) {
      const s = layer.strokes[i];
      for (let k = 0; k < LINE_NUMBERS.length; k++) {
        this.number(s.line[LINE_NUMBERS[k]]);
      }
      for (let k = 0; k < LINE_BOOLEANS.length; k++) {
        this.number(Number(s.line[LINE_BOOLEANS[k]]));
      }

      this.number(Number(s.line.fill !== null));
      if (s.line.fill) {
        this.paint(s.line.fill);
      }

      this.paths(s.paths);
      this.number(Number(s.triangles === true));
      const closes = s.closes ?? [];
      this.number(closes.length);
      for (let k = 0; k < closes.length; k++) {
        this.number(closes[k].at);
        this.number(closes[k].x);
        this.number(closes[k].y);
      }
    }

    const meshes = layer.meshes ?? [];
    this.number(meshes.length);
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      this.at = this.bitmaps.writeStore(m.image, this.data, this.at);
      this.number(Number(m.repeat));
      this.number(Number(m.smooth));
      this.numbers(m.positions);
      this.numbers(m.uvt);
    }

    this.number(Number(layer.extent !== undefined));
    if (layer.extent) {
      for (let i = 0; i < 5; i++) {
        this.number(layer.extent[i]);
      }
    }

    const parts = layer.mirrored;
    if (mirrored && parts) {
      throw new Error("recursive worker triangle layers");
    }

    this.number(Number(parts !== undefined));
    if (parts) {
      this.layer(
        { fills: parts.fills, strokes: parts.stroke ? [parts.stroke] : [], meshes: parts.meshes },
        true,
      );
    }
  }
}

class DrawingReader extends ValuesReader {
  readonly images: ImageBinding[] = [];
  readonly assets: SceneLibraries;
  readonly bitmaps: BitmapRecords;

  constructor(data: Float64Array, at: number, assets: SceneLibraries, bitmaps: BitmapRecords) {
    super(data, at);
    this.assets = assets;
    this.bitmaps = bitmaps;
  }

  matrix(): Matrix {
    return {
      a: this.number(),
      b: this.number(),
      c: this.number(),
      d: this.number(),
      tx: this.number(),
      ty: this.number(),
    };
  }

  numbers(): number[] {
    const length = this.count();
    const values: number[] = [];
    for (let i = 0; i < length; i++) {
      values.push(this.number());
    }

    return values;
  }

  paths(): Path[] {
    const count = this.count();
    const paths: Path[] = [];
    for (let i = 0; i < count; i++) {
      const path = this.numbers();
      for (let k = 0; k < path.length; ) {
        const op = path[k];
        if (!Number.isInteger(op) || op < 1 || op > 4) {
          throw new Error("invalid scene snapshot path command");
        }

        k += op === 4 ? 7 : op === 3 ? 5 : 3;
        if (k > path.length) {
          throw new Error("truncated scene snapshot path command");
        }
      }

      paths.push(path);
    }

    return paths;
  }

  paint(): Paint {
    const type = TYPES[this.integer(0, TYPES.length - 1)];
    switch (type) {
      case "solid":
        return { type, color: this.number() };
      case "image": {
        const dynamic = this.boolean();
        let pixels: BitmapPixels | null = null;
        let image: ImageFill["image"];
        if (dynamic) {
          const decoded = this.bitmaps.readStore(this.data, this.at);
          this.at = decoded.end;
          pixels = decoded.pixels;
          // Bound after the entire frame validates; no store is allocated here.
          image = empty;
        } else {
          const asset = this.assets.character(
            this.integer(1, Number.MAX_SAFE_INTEGER),
            this.integer(1, 65535),
          );
          if (asset?.type !== "bitmap" || !asset.pixels) {
            throw new Error("missing scene snapshot drawing bitmap");
          }

          image = asset;
        }

        const fill: ImageFill = {
          type,
          image,
          matrix: this.matrix(),
          repeat: this.boolean(),
          smooth: this.boolean(),
        };
        if (dynamic) {
          this.images.push({ target: fill, pixels });
        }

        return fill;
      }
      case "bitmap":
        return {
          type,
          bitmap: this.integer(0, 65535),
          matrix: this.matrix(),
          repeat: this.boolean(),
          smooth: this.boolean(),
        };
      default: {
        const matrix = this.matrix();
        const spread = this.integer(0, 2);
        const interpolation = this.integer(0, 1);
        const focal = this.number();
        const radial = this.boolean();
        const count = this.count();
        const stops = [];
        for (let i = 0; i < count; i++) {
          stops.push({ ratio: this.number(), color: this.number() });
        }

        return type === "gradient"
          ? { type, matrix, spread, linearRgb: !!interpolation, focal, radial, stops }
          : { type, gradient: { matrix, spread, interpolation, focal, stops } };
      }
    }
  }

  layer(mirrored = false): ShapeLayer {
    const layer: ShapeLayer = { fills: [], strokes: [] };
    const fills = this.count();
    for (let i = 0; i < fills; i++) {
      layer.fills.push({
        fill: this.paint(),
        winding: this.boolean() ? "nonZero" : "evenOdd",
        contours: this.paths(),
      });
    }

    const strokes = this.count();
    for (let i = 0; i < strokes; i++) {
      const line = {} as Line;
      for (let k = 0; k < LINE_NUMBERS.length; k++) {
        line[LINE_NUMBERS[k]] = this.number();
      }
      for (let k = 0; k < LINE_BOOLEANS.length; k++) {
        line[LINE_BOOLEANS[k]] = this.boolean();
      }

      const fill = this.boolean() ? this.paint() : null;
      if (fill?.type === "image" || fill?.type === "gradient") {
        throw new Error("invalid scene snapshot stroke fill");
      }

      line.fill = fill;
      const paths = this.paths();
      const triangles = this.boolean();
      const count = this.count();
      const closes = [];
      for (let k = 0; k < count; k++) {
        closes.push({
          at: this.integer(0, Number.MAX_SAFE_INTEGER),
          x: this.number(),
          y: this.number(),
        });
      }

      layer.strokes.push({ line, paths, triangles, closes });
    }

    const meshes = this.count();
    if (meshes) {
      layer.meshes = [];
    }
    for (let i = 0; i < meshes; i++) {
      const decoded = this.bitmaps.readStore(this.data, this.at);
      this.at = decoded.end;
      const repeat = this.boolean();
      const smooth = this.boolean();
      const positions = new Float32Array(this.numbers());
      const uvt = new Float32Array(this.numbers());
      if (positions.length % 6 || uvt.length !== (positions.length / 2) * 3) {
        throw new Error("invalid scene snapshot triangle vertices");
      }

      const mesh: TriangleMesh = {
        image: empty,
        repeat,
        smooth,
        positions,
        uvt,
      };
      this.images.push({ target: mesh, pixels: decoded.pixels });
      layer.meshes?.push(mesh);
    }

    if (this.boolean()) {
      layer.extent = [this.number(), this.number(), this.number(), this.number(), this.number()];
    }

    if (this.boolean()) {
      if (mirrored) {
        throw new Error("recursive scene snapshot triangle layers");
      }

      const parts = this.layer(true);
      if (parts.strokes.length > 1) {
        throw new Error("invalid scene snapshot mirrored stroke");
      }

      layer.mirrored = { fills: parts.fills, meshes: parts.meshes, stroke: parts.strokes[0] };
    }

    return layer;
  }
}

export function writeDrawing(
  drawing: Drawing,
  data: Float64Array,
  at: number,
  assets: SceneLibraries,
  bitmaps: BitmapSnapshot,
): number {
  const w = new DrawingWriter(data, at, assets, bitmaps);
  w.number(Number(drawing.culled));
  w.number(drawing.layers.length);
  for (let i = 0; i < drawing.layers.length; i++) {
    w.layer(drawing.layers[i]);
  }

  return w.at;
}

export function readDrawing(
  data: Float64Array,
  at: number,
  assets: SceneLibraries,
  bitmaps: BitmapRecords,
): { record: DrawingRecord; end: number } {
  const r = new DrawingReader(data, at, assets, bitmaps);
  const drawing = new Drawing();
  drawing.culled = r.boolean();
  const count = r.count();
  for (let i = 0; i < count; i++) {
    drawing.layers.push(r.layer());
  }

  return { record: { drawing, images: r.images }, end: r.at };
}

const empty = new BitmapStore(0, 0, true, 0);

export function bindDrawing(
  record: DrawingRecord,
  bitmaps: BitmapMirror,
  owner: DisplayObject,
): Drawing {
  for (let i = 0; i < record.images.length; i++) {
    const image = record.images[i];
    const store = bitmaps.store(image.pixels) ?? empty;
    if (store !== empty) {
      store.views.add(owner.ref);
    }
    image.target.image = store;
  }

  return record.drawing;
}
