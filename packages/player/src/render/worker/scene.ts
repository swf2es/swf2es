// Experimental complete snapshots of 2D scenes. Assets stay in a
// library registry loaded once per thread; scripting objects never enter shared memory.
import { IDENTITY_COLOR, sameColor } from "../../display/color.js";
import {
  BitmapObject,
  BUTTON,
  CHILDREN,
  Container,
  type DisplayObject,
  ShapeObject,
  StaticTextObject,
  TextObject,
  TRANSFORM,
} from "../../display/display.js";
import { BLEND_MODES } from "../../display/displayobject.js";
import type { Filter } from "../../display/filters.js";
import type { Library } from "../../display/timeline.js";
import { BitmapMirror, type BitmapRecord, BitmapRecords, BitmapSnapshot } from "./bitmaps.js";
import { readFilters, writeFilters } from "./filters.js";
import { type SceneLibraries, sceneLibraries } from "./libraries.js";
import { readText, SnapshotText, type TextRecord, writeText } from "./text.js";

const VERSION = 3;
const HEADER = 2;
const ROW = 25;
const CONTAINER = 1;
const VISIBLE = 2;
const STATIC_TEXT = 4;
const TEXT = 8;
const BITMAP = 16;
const KINDS = CONTAINER | STATIC_TEXT | TEXT | BITMAP;

/** Minimum space for the nodes, plus any filter and content tail values. */
export const sceneFrameBytes = (nodes: number, contentValues = 0): number =>
  (HEADER + nodes * ROW + contentValues) * 8;

export class SceneSnapshot {
  private readonly nodes: DisplayObject[] = [];
  private readonly parents: number[] = [];
  private readonly indices = new Map<DisplayObject, number>();

  private readonly assets: SceneLibraries;
  private readonly bitmaps = new BitmapSnapshot();

  constructor(source: Library | SceneLibraries) {
    this.assets = sceneLibraries(source);
  }

  encode(root: Container, bytes: Uint8Array): number {
    const data = new Float64Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 8));
    const nodes = this.nodes;
    const parents = this.parents;
    nodes.length = parents.length = 0;
    this.indices.clear();
    this.bitmaps.clear();
    nodes.push(root);
    parents.push(-1);

    try {
      for (let i = 0; i < nodes.length; i++) {
        if (sceneFrameBytes(nodes.length) > bytes.byteLength) {
          throw new RangeError("scene snapshot exceeds its slot capacity");
        }

        const o = nodes[i];
        const container = o instanceof Container;
        if (
          (!container &&
            !(o instanceof ShapeObject) &&
            !(o instanceof TextObject) &&
            !(o instanceof StaticTextObject) &&
            !(o instanceof BitmapObject)) ||
          o.kind === BUTTON ||
          o.drawing ||
          o.space ||
          o.projection ||
          o.scrollRect ||
          o.scale9Grid ||
          o.cachedAsBitmap ||
          !BLEND_MODES.includes(o.blendMode)
        ) {
          throw new Error(
            "experimental worker snapshot supports 2D shapes, text, bitmaps and containers only",
          );
        }

        this.indices.set(o, i);
        let character = 0;
        let library = 0;
        if (o instanceof ShapeObject) {
          if (
            o.morph ||
            o.stale ||
            !o.shape ||
            o.shape.id <= 0 ||
            o.shape.layers.some(
              (layer) =>
                layer.meshes?.length ||
                layer.strokes.some(({ line }) => line.fill?.type === "bitmap"),
            )
          ) {
            throw new Error(
              "experimental worker snapshot needs an unchanged shape from its library",
            );
          }

          const ref = this.assets.ref(o.shape);
          character = ref.character;
          library = ref.library;
          for (const layer of o.shape.layers) {
            for (const { fill } of layer.fills) {
              if (fill.type === "image") {
                if (
                  !("type" in fill.image) ||
                  !fill.image.pixels ||
                  fill.image.store?.version ||
                  fill.image.store?.disposed
                ) {
                  throw new Error("worker scene needs immutable library bitmap fills");
                }

                this.assets.ref(fill.image);
              }
            }
          }
        } else if (o instanceof StaticTextObject) {
          const ref = this.assets.ref(o.definition);
          character = ref.character;
          library = ref.library;
        }

        const at = HEADER + i * ROW;
        const m = o.matrix;
        const c = o.colorTransform ?? IDENTITY_COLOR;
        data.set(
          [
            o.serial,
            parents[i],
            character,
            (container
              ? CONTAINER
              : o instanceof StaticTextObject
                ? STATIC_TEXT
                : o instanceof TextObject
                  ? TEXT
                  : o instanceof BitmapObject
                    ? BITMAP
                    : 0) | (o.visible ? VISIBLE : 0),
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
            BLEND_MODES.indexOf(o.blendMode),
            o.depth ?? Number.NaN,
            o.clipDepth,
            -1,
            0,
            library,
            0,
          ],
          at,
        );

        if (container) {
          for (const child of o.children) {
            nodes.push(child);
            parents.push(i);
          }
        }
      }

      let end = HEADER + nodes.length * ROW;
      for (let i = 0; i < nodes.length; i++) {
        const o = nodes[i];
        const at = HEADER + i * ROW;
        if (o.mask) {
          const mask = this.indices.get(o.mask);
          if (mask === undefined || o.mask.maskOf !== o) {
            throw new Error("experimental worker snapshot needs masks inside its scene");
          }

          data[at + 21] = mask;
        }

        if (o.maskOf && (!this.indices.has(o.maskOf) || o.maskOf.mask !== o)) {
          throw new Error("experimental worker snapshot needs mask owners inside its scene");
        }

        if (o.filters.length) {
          data[at + 22] = end;
          end = writeFilters(o.filters, data, end);
        }

        if (o instanceof TextObject) {
          data[at + 24] = end;
          end = writeText(o, data, end, this.assets);
        } else if (o instanceof BitmapObject) {
          data[at + 24] = end;
          end = this.bitmaps.write(o, data, end);
        }
      }

      data[0] = VERSION;
      data[1] = nodes.length;

      return end * 8;
    } finally {
      // A failed or blocked publication must not retain removed display objects.
      nodes.length = parents.length = 0;
      this.indices.clear();
      this.bitmaps.clear();
    }
  }
}

interface MirrorNode {
  object: DisplayObject;
  character: number;
  library: number;
  kind: number;
  textValues: Float64Array;
  filterValues: Float64Array;
}

export class SceneMirror {
  private readonly nodes = new Map<number, MirrorNode>();
  private readonly seen = new Set<number>();
  private readonly rows: DisplayObject[] = [];
  private readonly childCounts: number[] = [];
  private readonly masks = new Set<number>();

  private readonly assets: SceneLibraries;
  private readonly bitmaps = new BitmapMirror();

  constructor(source: Library | SceneLibraries) {
    this.assets = sceneLibraries(source);
  }

  dispose(): void {
    this.bitmaps.begin();
    this.bitmaps.finish();
    this.nodes.clear();
    this.rows.length = 0;
  }

  apply(bytes: Uint8Array): Container {
    if (bytes.byteLength < sceneFrameBytes(1) || bytes.byteLength % 8 !== 0) {
      throw new Error("invalid scene snapshot length");
    }

    const data = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
    const count = data[1];
    if (
      data[0] !== VERSION ||
      !Number.isInteger(count) ||
      count < 1 ||
      sceneFrameBytes(count) > bytes.length
    ) {
      throw new Error("invalid scene snapshot header");
    }

    this.seen.clear();
    this.masks.clear();
    const filters: (readonly Filter[])[] = [];
    const filterEnds: number[] = [];
    const contentEnds: number[] = [];
    const texts: (TextRecord | null)[] = [];
    const bitmaps: (BitmapRecord | null)[] = [];
    const bitmapRecords = new BitmapRecords();
    let end = HEADER + count * ROW;
    // Validate before touching the mirror, so a rejected frame leaves it intact.
    for (let i = 0; i < count; i++) {
      const at = HEADER + i * ROW;
      const [id, parent, character, flags] = data.subarray(at, at + 4);
      const kind = flags & KINDS;
      const library = data[at + 23];
      const asset = this.assets.character(library, character);
      if (
        !Number.isSafeInteger(id) ||
        id < 0 ||
        this.seen.has(id) ||
        !Number.isInteger(flags) ||
        flags < 0 ||
        flags > (KINDS | VISIBLE) ||
        ![0, CONTAINER, STATIC_TEXT, TEXT, BITMAP].includes(kind) ||
        !Number.isSafeInteger(library) ||
        library < 0 ||
        !Number.isInteger(parent) ||
        (i === 0 ? parent !== -1 || !(flags & CONTAINER) : parent < 0 || parent >= i) ||
        (i > 0 && !(data[HEADER + parent * ROW + 3] & CONTAINER)) ||
        (kind === 0 || kind === STATIC_TEXT
          ? !Number.isInteger(character) ||
            character <= 0 ||
            asset?.type !== (kind === 0 ? "shape" : "static")
          : character !== 0 || library !== 0)
      ) {
        throw new Error("invalid scene snapshot node");
      }

      const blend = data[at + 18];
      const depth = data[at + 19];
      const clipDepth = data[at + 20];
      const mask = data[at + 21];
      const offset = data[at + 22];
      if (
        !Number.isInteger(blend) ||
        blend < 0 ||
        blend >= BLEND_MODES.length ||
        (!Number.isNaN(depth) && !Number.isSafeInteger(depth)) ||
        !Number.isSafeInteger(clipDepth) ||
        clipDepth < 0 ||
        !Number.isInteger(mask) ||
        mask < -1 ||
        mask >= count ||
        (mask !== -1 && this.masks.has(mask)) ||
        (offset !== 0 && offset !== end)
      ) {
        throw new Error("invalid scene snapshot effects");
      }

      if (mask !== -1) {
        this.masks.add(mask);
      }

      if (offset !== 0) {
        const decoded = readFilters(data, offset);
        end = decoded.end;
        filters.push(decoded.filters);
      } else {
        filters.push([]);
      }

      filterEnds.push(end);
      const content = data[at + 24];
      if (kind === TEXT || kind === BITMAP) {
        if (content !== end) {
          throw new Error("invalid scene snapshot content offset");
        }

        if (kind === TEXT) {
          const decoded = readText(data, content, this.assets);
          texts.push(decoded.record);
          bitmaps.push(null);
          end = decoded.end;
        } else {
          const decoded = bitmapRecords.read(data, content);
          texts.push(null);
          bitmaps.push(decoded.record);
          end = decoded.end;
        }
      } else {
        if (content !== 0) {
          throw new Error("unexpected scene snapshot content");
        }

        texts.push(null);
        bitmaps.push(null);
      }

      contentEnds.push(end);
      this.seen.add(id);
    }

    if (end !== data.length) {
      throw new Error("invalid scene snapshot filter tail");
    }

    const rows = this.rows;
    rows.length = 0;
    this.childCounts.length = count;
    this.childCounts.fill(0);

    this.bitmaps.begin();
    for (let i = 0; i < count; i++) {
      const at = HEADER + i * ROW;
      const id = data[at];
      const character = data[at + 2];
      const library = data[at + 23];
      const kind = data[at + 3] & KINDS;
      let node = this.nodes.get(id);
      if (!node || node.character !== character || node.library !== library || node.kind !== kind) {
        node?.object.setMask(null);
        node?.object.maskOf?.setMask(null);
        node?.object.parent?.removeChild(node.object);
        const asset = this.assets.character(library, character);
        node = {
          object:
            kind === CONTAINER
              ? new Container()
              : kind === TEXT
                ? new SnapshotText()
                : kind === BITMAP
                  ? new BitmapObject(null)
                  : asset?.type === "static"
                    ? new StaticTextObject(
                        asset,
                        (this.assets.library(library) as Library).characters,
                      )
                    : new ShapeObject(asset?.type === "shape" ? asset : null),
          character,
          library,
          kind,
          textValues: new Float64Array(),
          filterValues: new Float64Array(),
        };
        this.nodes.set(id, node);
      }

      const o = node.object;
      const m = o.matrix;
      const visible = !!(data[at + 3] & VISIBLE);
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
      const ct = sameColor(color, IDENTITY_COLOR) ? null : color;
      if (
        m.a !== data[at + 4] ||
        m.b !== data[at + 5] ||
        m.c !== data[at + 6] ||
        m.d !== data[at + 7] ||
        m.tx !== data[at + 8] ||
        m.ty !== data[at + 9] ||
        o.visible !== visible ||
        !sameColor(o.colorTransform, ct)
      ) {
        o.matrix = {
          a: data[at + 4],
          b: data[at + 5],
          c: data[at + 6],
          d: data[at + 7],
          tx: data[at + 8],
          ty: data[at + 9],
        };
        o.colorTransform = ct;
        o.visible = visible;
        o.invalidate(TRANSFORM);
      }

      const offset = data[at + 22];
      const values = offset ? data.subarray(offset, filterEnds[i]) : data.subarray(0, 0);
      if (
        node.filterValues.length !== values.length ||
        !node.filterValues.every((v, k) => Object.is(v, values[k]))
      ) {
        node.filterValues = values.slice();
        o.filters = filters[i];
        o.invalidate(TRANSFORM);
      }

      if (o instanceof SnapshotText) {
        const values = data.subarray(data[at + 24], contentEnds[i]);
        if (
          node.textValues.length !== values.length ||
          !node.textValues.every((v, k) => Object.is(v, values[k]))
        ) {
          node.textValues = values.slice();
          o.apply(texts[i] as TextRecord);
        }
      } else if (o instanceof BitmapObject) {
        this.bitmaps.apply(o, bitmaps[i] as BitmapRecord);
      }

      const blend = BLEND_MODES[data[at + 18]];
      if (o.blendMode !== blend) {
        o.blendMode = blend;
        o.invalidate(TRANSFORM);
      }

      rows.push(o);
      if (i === 0) {
        o.parent?.removeChild(o);
      } else {
        const parent = data[at + 1];
        const container = rows[parent] as Container;
        const index = this.childCounts[parent]++;
        if (container.children[index] !== o) {
          container.addChildAt(o, index);
        }
      }
    }

    for (const [id, node] of this.nodes) {
      if (!this.seen.has(id)) {
        node.object.setMask(null);
        node.object.maskOf?.setMask(null);
        node.object.parent?.removeChild(node.object);
        this.nodes.delete(id);
      }
    }

    // Reordering children clears their timeline depths; restore these only
    // after the full tree is attached, before Pixi groups timeline masks.
    for (const o of rows) {
      if (o instanceof Container) {
        o.depths.clear();
      }
    }

    for (let i = 0; i < count; i++) {
      const at = HEADER + i * ROW;
      const o = rows[i];
      const depth = Number.isNaN(data[at + 19]) ? null : data[at + 19];
      const clipDepth = data[at + 20];
      if (o.depth !== depth || o.clipDepth !== clipDepth) {
        o.depth = depth;
        o.clipDepth = clipDepth;
        o.invalidate(TRANSFORM);
        o.parent?.invalidate(CHILDREN);
      }

      if (depth !== null) {
        o.parent?.depths.set(depth, o);
      }

      const mask = data[at + 21];
      if (o.mask !== (mask === -1 ? null : rows[mask])) {
        o.setMask(null);
      }
    }

    for (let i = 0; i < count; i++) {
      const mask = data[HEADER + i * ROW + 21];
      rows[i].setMask(mask === -1 ? null : rows[mask]);
    }

    this.bitmaps.finish();
    return rows[0] as Container;
  }
}
