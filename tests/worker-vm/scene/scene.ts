// Experimental complete snapshots of 2D scenes. Assets stay in a
// library registry loaded once per thread; scripting objects never enter shared memory.
import { IDENTITY_COLOR } from "../../../packages/player/dist/display/color.js";
import {
  BitmapObject,
  CHILDREN,
  CONTENT,
  Container,
  type DisplayObject,
  ShapeObject,
  StaticTextObject,
  TextObject,
  TRANSFORM,
} from "../../../packages/player/dist/display/display.js";
import { BLEND_MODES } from "../../../packages/player/dist/display/displayobject.js";
import type { Filter } from "../../../packages/player/dist/display/filters.js";
import type { Rect } from "../../../packages/player/dist/display/geometry.js";
import type { Library, MorphCharacter } from "../../../packages/player/dist/display/timeline.js";
import { BitmapMirror, type BitmapRecord, BitmapRecords, BitmapSnapshot } from "./bitmaps.ts";
import { bindDrawing, type DrawingRecord, readDrawing, writeDrawing } from "./drawing.ts";
import { readFilters, writeFilters } from "./filters.ts";
import { type SceneLibraries, sceneLibraries } from "./libraries.ts";
import { readText, SnapshotText, type TextRecord, writeText } from "./text.ts";
import { ValuesReader, ValuesWriter } from "./values.ts";

const VERSION = 5;
const HEADER = 2;
const ROW = 27;
const CONTAINER = 1;
const VISIBLE = 2;
const STATIC_TEXT = 4;
const TEXT = 8;
const BITMAP = 16;
const DYNAMIC = 32;
const MORPH = 64;
const KINDS = CONTAINER | STATIC_TEXT | TEXT | BITMAP | DYNAMIC | MORPH;
const NODE_KINDS = [0, CONTAINER, STATIC_TEXT, TEXT, BITMAP, DYNAMIC, MORPH];
const DRAWING_KINDS = [CONTAINER, 0, DYNAMIC, MORPH];
const EMPTY_VALUES = new Float64Array();
const EMPTY_BYTES = new Uint8Array();
const EMPTY_FILTERS: readonly Filter[] = Object.freeze([]);
interface DisplayState {
  cached: boolean;
  scroll: Rect | null;
  grid: Rect | null;
}
const DEFAULT_DISPLAY_STATE: DisplayState = { cached: false, scroll: null, grid: null };

/** Minimum space for the nodes, plus any filter and content tail values. */
export const sceneFrameBytes = (nodes: number, contentValues = 0): number =>
  (HEADER + nodes * ROW + contentValues) * 8;

export interface MorphPresentation {
  object: ShapeObject;
  morph: MorphCharacter;
  ratio: number;
}

export class SceneSnapshot {
  private readonly nodes: DisplayObject[] = [];
  private readonly parents: number[] = [];
  private readonly indices = new Map<DisplayObject, number>();

  private readonly assets: SceneLibraries;
  private readonly bitmaps = new BitmapSnapshot();

  constructor(source: Library | SceneLibraries) {
    this.assets = sceneLibraries(source);
  }

  encode(root: DisplayObject, bytes: Uint8Array, morphs?: MorphPresentation[]): number {
    if (morphs) {
      morphs.length = 0;
    }
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
          (o.drawing && !container && !(o instanceof ShapeObject)) ||
          o.space ||
          o.projection ||
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
            o.stale ||
            (!o.drawing && !o.morph && o.shape && o.shape.id <= 0) ||
            o.shape?.layers.some(
              (layer) =>
                layer.meshes?.length ||
                layer.strokes.some(({ line }) => line.fill?.type === "bitmap"),
            )
          ) {
            throw new Error(
              "experimental worker snapshot needs an unchanged shape from its library",
            );
          }

          const asset = o.morph ?? o.shape;
          if (!o.drawing && asset) {
            const ref = this.assets.ref(asset);
            character = ref.character;
            library = ref.library;
          }

          const layers = o.shape?.layers ?? [];
          for (let k = 0; k < layers.length; k++) {
            const fills = layers[k].fills;
            for (let j = 0; j < fills.length; j++) {
              const fill = fills[j].fill;
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
        data[at] = o.serial;
        data[at + 1] = parents[i];
        data[at + 2] = character;
        data[at + 3] =
          (container
            ? CONTAINER
            : o instanceof StaticTextObject
              ? STATIC_TEXT
              : o instanceof TextObject
                ? TEXT
                : o instanceof BitmapObject
                  ? BITMAP
                  : o.drawing || (o instanceof ShapeObject && !o.shape)
                    ? DYNAMIC
                    : o instanceof ShapeObject && o.morph
                      ? MORPH
                      : 0) | (o.visible ? VISIBLE : 0);
        data[at + 4] = m.a;
        data[at + 5] = m.b;
        data[at + 6] = m.c;
        data[at + 7] = m.d;
        data[at + 8] = m.tx;
        data[at + 9] = m.ty;
        data[at + 10] = c.rMul;
        data[at + 11] = c.gMul;
        data[at + 12] = c.bMul;
        data[at + 13] = c.aMul;
        data[at + 14] = c.rAdd;
        data[at + 15] = c.gAdd;
        data[at + 16] = c.bAdd;
        data[at + 17] = c.aAdd;
        data[at + 18] = BLEND_MODES.indexOf(o.blendMode);
        data[at + 19] = o.depth ?? Number.NaN;
        data[at + 20] = o.clipDepth;
        data[at + 21] = -1;
        data[at + 22] = 0;
        data[at + 23] = library;
        data[at + 24] = 0;
        data[at + 25] = 0;
        data[at + 26] = 0;

        if (container) {
          for (let k = 0; k < o.children.length; k++) {
            nodes.push(o.children[k]);
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
        } else if (o instanceof ShapeObject && o.morph && !o.drawing) {
          data[at + 24] = end;
          if (!Number.isInteger(o.ratio) || o.ratio < 0 || o.ratio > 65535) {
            throw new Error("invalid worker morph ratio");
          }
          if (end >= data.length) {
            throw new RangeError("scene snapshot exceeds its slot capacity");
          }

          data[end++] = o.ratio;
          morphs?.push({ object: o, morph: o.morph, ratio: o.ratio });
        }

        if (o.drawing) {
          data[at + 25] = end;
          end = writeDrawing(o.drawing, data, end, this.assets, this.bitmaps);
        }

        const flags = Number(o.cachedAsBitmap) | (o.scroll ? 2 : 0) | (o.scale9Grid ? 4 : 0);
        if (flags) {
          data[at + 26] = end;
          const w = new ValuesWriter(data, end);
          w.number(flags);
          const rects = [o.scroll, o.scale9Grid];
          for (let k = 0; k < rects.length; k++) {
            const rect = rects[k];
            if (rect) {
              w.number(rect.xMin);
              w.number(rect.yMin);
              w.number(rect.xMax);
              w.number(rect.yMax);
            }
          }
          end = w.at;
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
  drawingValues: Uint8Array;
  drawingImages: object[];
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

  apply(bytes: Uint8Array): DisplayObject {
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
    const drawings: (DrawingRecord | null)[] = [];
    const drawingEnds: number[] = [];
    const ratios: number[] = [];
    const displayStates: (DisplayState | null)[] = [];
    const bitmapRecords = new BitmapRecords();
    let end = HEADER + count * ROW;
    // Validate before touching the mirror, so a rejected frame leaves it intact.
    for (let i = 0; i < count; i++) {
      const at = HEADER + i * ROW;
      const id = data[at];
      const parent = data[at + 1];
      const character = data[at + 2];
      const flags = data[at + 3];
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
        !NODE_KINDS.includes(kind) ||
        !Number.isSafeInteger(library) ||
        library < 0 ||
        !Number.isInteger(parent) ||
        (i === 0 ? parent !== -1 : parent < 0 || parent >= i) ||
        (i > 0 && !(data[HEADER + parent * ROW + 3] & CONTAINER)) ||
        (kind === 0 || kind === STATIC_TEXT || kind === MORPH
          ? !Number.isInteger(character) ||
            character <= 0 ||
            asset?.type !== (kind === 0 ? "shape" : kind === MORPH ? "morph" : "static")
          : character !== 0 || library !== 0)
      ) {
        throw new Error(
          `invalid scene snapshot node: row ${i}, id ${id}, parent ${parent}, kind ${kind}, asset ${library}:${character} (${asset?.type ?? "missing"})`,
        );
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
        filters.push(EMPTY_FILTERS);
      }

      filterEnds.push(end);
      const content = data[at + 24];
      if (kind === TEXT || kind === BITMAP || kind === MORPH) {
        if (content !== end) {
          throw new Error("invalid scene snapshot content offset");
        }

        if (kind === TEXT) {
          const decoded = readText(data, content, this.assets);
          texts.push(decoded.record);
          bitmaps.push(null);
          end = decoded.end;
        } else if (kind === MORPH) {
          if (
            content >= data.length ||
            !Number.isInteger(data[content]) ||
            data[content] < 0 ||
            data[content] > 65535
          ) {
            throw new Error("invalid scene snapshot morph ratio");
          }

          texts.push(null);
          bitmaps.push(null);
          end = content + 1;
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
      ratios.push(kind === MORPH ? data[content] : 0);
      const drawing = data[at + 25];
      if (drawing !== 0) {
        if (drawing !== end || !DRAWING_KINDS.includes(kind)) {
          throw new Error("invalid scene snapshot drawing offset");
        }

        const decoded = readDrawing(data, drawing, this.assets, bitmapRecords);
        drawings.push(decoded.record);
        end = decoded.end;
      } else {
        drawings.push(null);
      }

      drawingEnds.push(end);
      const state = data[at + 26];
      let cached = false;
      let scroll: Rect | null = null;
      let grid: Rect | null = null;
      if (state !== 0) {
        if (state !== end) {
          throw new Error("invalid scene snapshot display state offset");
        }

        const r = new ValuesReader(data, end);
        const flags = r.integer(1, 7);
        cached = !!(flags & 1);
        const rect = (): Rect => ({
          xMin: r.number(),
          yMin: r.number(),
          xMax: r.number(),
          yMax: r.number(),
        });
        scroll = flags & 2 ? rect() : null;
        grid = flags & 4 ? rect() : null;
        end = r.at;
      }
      displayStates.push(state === 0 ? null : { cached, scroll, grid });
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
                    : asset?.type === "morph"
                      ? ShapeObject.ofMorph(asset)
                      : new ShapeObject(asset?.type === "shape" ? asset : null),
          character,
          library,
          kind,
          textValues: EMPTY_VALUES,
          drawingValues: EMPTY_BYTES,
          drawingImages: [],
          filterValues: EMPTY_VALUES,
        };
        this.nodes.set(id, node);
      }

      const o = node.object;
      const m = o.matrix;
      const visible = !!(data[at + 3] & VISIBLE);
      const previous = o.colorTransform;
      const identity =
        data[at + 10] === 1 &&
        data[at + 11] === 1 &&
        data[at + 12] === 1 &&
        data[at + 13] === 1 &&
        data[at + 14] === 0 &&
        data[at + 15] === 0 &&
        data[at + 16] === 0 &&
        data[at + 17] === 0;
      const colorChanged = identity
        ? previous !== null
        : previous === null ||
          previous.rMul !== data[at + 10] ||
          previous.gMul !== data[at + 11] ||
          previous.bMul !== data[at + 12] ||
          previous.aMul !== data[at + 13] ||
          previous.rAdd !== data[at + 14] ||
          previous.gAdd !== data[at + 15] ||
          previous.bAdd !== data[at + 16] ||
          previous.aAdd !== data[at + 17];
      if (
        m.a !== data[at + 4] ||
        m.b !== data[at + 5] ||
        m.c !== data[at + 6] ||
        m.d !== data[at + 7] ||
        m.tx !== data[at + 8] ||
        m.ty !== data[at + 9] ||
        o.visible !== visible ||
        colorChanged
      ) {
        o.matrix = {
          a: data[at + 4],
          b: data[at + 5],
          c: data[at + 6],
          d: data[at + 7],
          tx: data[at + 8],
          ty: data[at + 9],
        };
        if (colorChanged) {
          o.colorTransform = identity
            ? null
            : {
                rMul: data[at + 10],
                gMul: data[at + 11],
                bMul: data[at + 12],
                aMul: data[at + 13],
                rAdd: data[at + 14],
                gAdd: data[at + 15],
                bAdd: data[at + 16],
                aAdd: data[at + 17],
              };
        }
        o.visible = visible;
        o.invalidate(TRANSFORM);
      }

      const offset = data[at + 22];
      const filterStart = offset || 0;
      const filterEnd = offset ? filterEnds[i] : 0;
      if (!sameValuesAt(node.filterValues, data, filterStart, filterEnd)) {
        node.filterValues = offset ? data.slice(filterStart, filterEnd) : EMPTY_VALUES;
        o.filters = filters[i];
        o.invalidate(TRANSFORM);
      }

      if (o instanceof SnapshotText) {
        const start = data[at + 24],
          end = contentEnds[i];
        if (!sameValuesAt(node.textValues, data, start, end)) {
          node.textValues = data.slice(start, end);
          o.apply(texts[i] as TextRecord);
        }
      } else if (o instanceof BitmapObject) {
        this.bitmaps.apply(o, bitmaps[i] as BitmapRecord);
      }

      if (o instanceof ShapeObject && o.ratio !== ratios[i]) {
        o.ratio = ratios[i];
        o.invalidate(CONTENT);
      }

      const drawing = drawings[i];
      const drawingStart = data[at + 25];
      // Byte comparison preserves packed bitmap bits even where Float64 reads NaN.
      const drawingByteStart = drawingStart * 8;
      const drawingByteEnd = drawingStart ? drawingEnds[i] * 8 : 0;
      const resolved = drawing ? bindDrawing(drawing, this.bitmaps, o) : null;
      let imagesChanged = node.drawingImages.length !== (drawing?.images.length ?? 0);
      if (drawing) {
        for (let k = 0; k < drawing.images.length; k++) {
          if (node.drawingImages[k] !== drawing.images[k].target.image) {
            imagesChanged = true;
          }
        }
      }

      if (
        imagesChanged ||
        !sameValuesAt(node.drawingValues, bytes, drawingByteStart, drawingByteEnd)
      ) {
        node.drawingImages.length = 0;
        if (drawing) {
          for (let k = 0; k < drawing.images.length; k++) {
            node.drawingImages.push(drawing.images[k].target.image);
          }
        }

        node.drawingValues = drawingStart
          ? bytes.slice(drawingByteStart, drawingByteEnd)
          : EMPTY_BYTES;
        o.drawing = resolved;
        o.invalidate(CONTENT);
      }

      const state = displayStates[i] ?? DEFAULT_DISPLAY_STATE;
      if (
        o.cachedAsBitmap !== state.cached ||
        !sameRect(o.scroll, state.scroll) ||
        !sameRect(o.scale9Grid, state.grid)
      ) {
        o.cachedAsBitmap = state.cached;
        o.scroll = state.scroll;
        o.scrollRect = state.scroll;
        o.scale9Grid = state.grid;
        o.invalidate(CONTENT | TRANSFORM);
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
    for (let i = 0; i < rows.length; i++) {
      const o = rows[i];
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
    return rows[0];
  }
}

function sameValuesAt(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  start: number,
  end: number,
): boolean {
  if (a.length !== end - start) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[start + i])) {
      return false;
    }
  }

  return true;
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      Object.is(a.xMin, b.xMin) &&
      Object.is(a.yMin, b.yMin) &&
      Object.is(a.xMax, b.xMax) &&
      Object.is(a.yMax, b.yMax))
  );
}
