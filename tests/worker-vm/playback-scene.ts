// A bounded 2D playback experiment. Flash records cross the boundary; Pixi does not.
import { IDENTITY_COLOR, sameColor } from "../../packages/player/dist/display/color.js";
import {
  BLEND_MODES,
  CHILDREN,
  CONTENT,
  Container,
  type DisplayObject,
  ShapeObject,
  TRANSFORM,
} from "../../packages/player/dist/display/display.js";
import type { Filter } from "../../packages/player/dist/display/filters.js";
import type { ShapeCharacter } from "../../packages/player/dist/display/timeline.js";

const ROW = 22;
const MAX_NODES = 32768;
const MAX_ASSETS = 8192;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const FREE = 0;
const WRITING = 1;
const READY = 2;
const READING = 3;

export interface FrameSlot {
  control: SharedArrayBuffer;
  values: SharedArrayBuffer;
}

export function frameSlot(): FrameSlot {
  return {
    control: new SharedArrayBuffer(12),
    values: new SharedArrayBuffer(MAX_NODES * ROW * 8),
  };
}

export interface FramePacket {
  sequence: number;
  shapes: [number, ShapeCharacter][];
  filters: [number, readonly Filter[]][];
}

export class FrameWriter {
  private sequence = 0;
  private shapeIds = new WeakMap<ShapeCharacter, number>();
  private filterIds = new Map<string, number>();
  private shapeCount = 0;
  private assetBytes = 0;

  capture(root: DisplayObject, slot: FrameSlot): FramePacket {
    const control = new Int32Array(slot.control);
    if (Atomics.compareExchange(control, 0, FREE, WRITING) !== FREE) {
      throw new Error("playback frame slot is still owned by its reader");
    }

    const packet: FramePacket = { sequence: this.sequence + 1, shapes: [], filters: [] };
    const newShapes: [ShapeCharacter, number][] = [];
    const newFilters: [string, number][] = [];
    const bytesBefore = this.assetBytes;
    const shapesBefore = this.shapeCount;
    const nodes: DisplayObject[] = [root];
    const parents = [-1];
    const data = new Float64Array(slot.values);
    try {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes.length > MAX_NODES) {
          throw new RangeError("playback scene exceeds 32768 nodes");
        }

        const o = nodes[i];
        if (
          !(o instanceof Container || o instanceof ShapeObject) ||
          o.drawing ||
          o.space ||
          o.projection ||
          o.mask ||
          o.maskOf ||
          o.clipDepth ||
          o.scrollRect ||
          o.scroll ||
          o.scale9Grid ||
          (o instanceof ShapeObject && (o.stale || o.morph))
        ) {
          throw new Error(
            "playback probe supports 2D containers and static vector shapes; unsupported display content",
          );
        }

        let asset = 0;
        if (o instanceof ShapeObject && o.shape) {
          let id = this.shapeIds.get(o.shape);
          if (!id) {
            for (let j = 0; j < o.shape.layers.length; j++) {
              const layer = o.shape.layers[j];
              if (
                layer.meshes?.length ||
                layer.fills.some((p) => p.fill.type === "image" || p.fill.type === "bitmap") ||
                layer.strokes.some((p) => p.line.fill?.type === "bitmap")
              ) {
                throw new Error("playback probe does not support image fills or meshes");
              }
            }

            id = ++this.shapeCount;
            if (id > MAX_ASSETS) {
              throw new RangeError("playback asset limit exceeded");
            }

            this.assetBytes += JSON.stringify(o.shape).length * 2;
            this.shapeIds.set(o.shape, id);
            newShapes.push([o.shape, id]);
            packet.shapes.push([id, o.shape]);
          }

          asset = id;
        }

        let filters = 0;
        if (o.filters.length) {
          for (let j = 0; j < o.filters.length; j++) {
            const f = o.filters[j];
            if (f.kind === "displacementMap" || f.mapBitmap || f.mapSnapshot) {
              throw new Error("playback probe does not support displacement maps");
            }
          }

          const key = JSON.stringify(o.filters, (_key, value) =>
            typeof value === "number" && !Number.isFinite(value) ? String(value) : value,
          );
          let id = this.filterIds.get(key);
          if (!id) {
            id = this.filterIds.size + 1;
            if (id > MAX_ASSETS) {
              throw new RangeError("playback filter limit exceeded");
            }

            this.assetBytes += key.length * 2;
            this.filterIds.set(key, id);
            newFilters.push([key, id]);
            packet.filters.push([id, o.filters]);
          }

          filters = id;
        }

        if (this.assetBytes > MAX_ASSET_BYTES) {
          throw new RangeError("playback assets exceed 64 MiB");
        }

        const blend = BLEND_MODES.indexOf(o.blendMode);
        if (blend < 0) {
          throw new Error("unsupported playback blend mode");
        }

        const m = o.matrix;
        const c = o.colorTransform ?? IDENTITY_COLOR;
        data.set(
          [
            o.serial,
            parents[i],
            o instanceof Container ? -1 : asset,
            Number(o.visible),
            m.a,
            m.b,
            m.c,
            m.d,
            m.tx,
            m.ty,
            c.rMul,
            c.gMul,
            c.bMul,
            c.aMul,
            c.rAdd,
            c.gAdd,
            c.bAdd,
            c.aAdd,
            blend,
            filters,
            Number(o.cachedAsBitmap),
            o.depth ?? Number.NaN,
          ],
          i * ROW,
        );
        if (o instanceof Container) {
          if (o.children.length > MAX_NODES - nodes.length) {
            throw new RangeError("playback scene exceeds 32768 nodes");
          }
          for (let j = 0; j < o.children.length; j++) {
            nodes.push(o.children[j]);
            parents.push(i);
          }
        }
      }

      this.sequence = packet.sequence;
      Atomics.store(control, 1, nodes.length);
      Atomics.store(control, 2, packet.sequence);
      Atomics.store(control, 0, READY);
      return packet;
    } catch (error) {
      for (let i = 0; i < newShapes.length; i++) {
        this.shapeIds.delete(newShapes[i][0]);
      }
      this.shapeCount = shapesBefore;
      for (let i = 0; i < newFilters.length; i++) {
        this.filterIds.delete(newFilters[i][0]);
      }
      this.assetBytes = bytesBefore;
      Atomics.store(control, 0, FREE);
      throw error;
    }
  }
}

export class FrameAssets {
  readonly shapes = new Map<number, ShapeCharacter>();
  readonly filters = new Map<number, readonly Filter[]>();

  add(packet: FramePacket): void {
    for (let i = 0; i < packet.shapes.length; i++) {
      const [id, shape] = packet.shapes[i];
      if (!Number.isSafeInteger(id) || this.shapes.has(id) || id < 1 || id > MAX_ASSETS) {
        throw new Error("invalid playback shape registration");
      }
      this.shapes.set(id, shape);
    }
    for (let i = 0; i < packet.filters.length; i++) {
      const [id, filters] = packet.filters[i];
      if (!Number.isSafeInteger(id) || this.filters.has(id) || id < 1 || id > MAX_ASSETS) {
        throw new Error("invalid playback filter registration");
      }
      this.filters.set(id, filters);
    }
  }
}

export class FrameMirror {
  private nodes = new Map<number, DisplayObject>();
  private readonly assets: FrameAssets;

  constructor(assets: FrameAssets) {
    this.assets = assets;
  }

  apply(packet: FramePacket, slot: FrameSlot): DisplayObject {
    const control = new Int32Array(slot.control);
    if (Atomics.compareExchange(control, 0, READY, READING) !== READY) {
      throw new Error("playback frame was not published");
    }

    try {
      const count = Atomics.load(control, 1);
      if (Atomics.load(control, 2) !== packet.sequence || count < 1 || count > MAX_NODES) {
        throw new Error("invalid playback frame header");
      }
      const data = new Float64Array(slot.values, 0, count * ROW);
      const ids = new Set<number>();
      // Reject a broken tree before changing the retained display objects.
      for (let i = 0; i < count; i++) {
        const at = i * ROW;
        const id = data[at],
          parent = data[at + 1],
          asset = data[at + 2];
        const filter = data[at + 19];
        if (
          !Number.isSafeInteger(id) ||
          id < 0 ||
          ids.has(id) ||
          !Number.isInteger(parent) ||
          (i === 0 ? parent !== -1 : parent < 0 || parent >= i || data[parent * ROW + 2] !== -1) ||
          !Number.isInteger(asset) ||
          asset < -1 ||
          (asset > 0 && !this.assets.shapes.has(asset)) ||
          !Number.isInteger(filter) ||
          filter < 0 ||
          (filter > 0 && !this.assets.filters.has(filter)) ||
          !Number.isInteger(data[at + 18]) ||
          !BLEND_MODES[data[at + 18]]
        ) {
          throw new Error("invalid playback frame node");
        }
        ids.add(id);
      }

      const current = new Map<number, DisplayObject>();
      const rows: DisplayObject[] = [];
      const children = new Map<Container, DisplayObject[]>();
      const containers: Container[] = [];
      for (let i = 0; i < count; i++) {
        const at = i * ROW;
        const id = data[at],
          asset = data[at + 2];
        let o = this.nodes.get(id);
        const shape = this.assets.shapes.get(asset) ?? null;
        if (!o || (asset === -1) !== o instanceof Container) {
          o = asset === -1 ? new Container() : new ShapeObject(shape);
        }
        if (o instanceof ShapeObject && o.shape !== shape) {
          o.shape = shape;
          o.character = shape;
          o.invalidate(CONTENT);
        }

        const m = o.matrix;
        if (
          m.a !== data[at + 4] ||
          m.b !== data[at + 5] ||
          m.c !== data[at + 6] ||
          m.d !== data[at + 7] ||
          m.tx !== data[at + 8] ||
          m.ty !== data[at + 9]
        ) {
          o.setMatrix({
            a: data[at + 4],
            b: data[at + 5],
            c: data[at + 6],
            d: data[at + 7],
            tx: data[at + 8],
            ty: data[at + 9],
          });
        }
        const color = {
          rMul: data[at + 10],
          gMul: data[at + 11],
          bMul: data[at + 12],
          aMul: data[at + 13],
          rAdd: data[at + 14],
          gAdd: data[at + 15],
          bAdd: data[at + 16],
          aAdd: data[at + 17],
        };
        const filters = this.assets.filters.get(data[at + 19]) ?? NO_FILTERS;
        const blend = BLEND_MODES[data[at + 18]];
        const visible = data[at + 3] === 1,
          cached = data[at + 20] === 1;
        if (
          !sameColor(o.colorTransform, color) ||
          o.visible !== visible ||
          o.filters !== filters ||
          o.blendMode !== blend ||
          o.cachedAsBitmap !== cached
        ) {
          o.colorTransform = color;
          o.visible = visible;
          o.filters = filters;
          o.blendMode = blend;
          o.cachedAsBitmap = cached;
          o.invalidate(TRANSFORM);
        }
        o.depth = Number.isNaN(data[at + 21]) ? null : data[at + 21];
        current.set(id, o);
        rows.push(o);
        if (o instanceof Container) {
          children.set(o, []);
          containers.push(o);
        }
        if (i > 0) {
          children.get(rows[data[at + 1]] as Container)?.push(o);
        }
      }

      for (let c = 0; c < containers.length; c++) {
        const container = containers[c];
        const next = children.get(container) as DisplayObject[];
        const prior = container.children;
        let changed = prior.length !== next.length;
        for (let i = 0; !changed && i < next.length; i++) {
          changed = prior[i] !== next[i];
        }
        if (changed) {
          for (let i = 0; i < prior.length; i++) {
            if (prior[i].parent === container) {
              prior[i].parent = null;
            }
          }
          prior.length = 0;
          prior.push(...next);
          container.depths.clear();
          container.invalidate(CHILDREN);
        }
      }
      // Reparent only after every old list has been detached.
      for (let c = 0; c < containers.length; c++) {
        const container = containers[c];
        const next = children.get(container) as DisplayObject[];
        container.depths.clear();
        for (let i = 0; i < next.length; i++) {
          const child = next[i];
          child.parent = container;
          if (child.depth !== null) {
            container.depths.set(child.depth, child);
          }
        }
      }
      rows[0].parent = null;
      this.nodes = current;
      return rows[0];
    } finally {
      Atomics.store(control, 0, FREE);
    }
  }
}

const NO_FILTERS: readonly Filter[] = [];
