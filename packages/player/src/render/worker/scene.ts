// Experimental complete snapshots of 2D vector scenes. Assets stay in a
// library loaded once per thread; scripting objects never enter shared memory.
import { IDENTITY_COLOR, sameColor } from "../../display/color.js";
import {
  BUTTON,
  CHILDREN,
  Container,
  type DisplayObject,
  ShapeObject,
  TRANSFORM,
} from "../../display/display.js";
import { BLEND_MODES } from "../../display/displayobject.js";
import type { Filter } from "../../display/filters.js";
import type { Library } from "../../display/timeline.js";
import { readFilters, writeFilters } from "./filters.js";

const VERSION = 2;
const HEADER = 2;
const ROW = 23;
const CONTAINER = 1;
const VISIBLE = 2;

/** Minimum space for the nodes, plus any filter tail values. */
export const vectorFrameBytes = (nodes: number, filterValues = 0): number =>
  (HEADER + nodes * ROW + filterValues) * 8;

export class VectorSnapshot {
  private readonly nodes: DisplayObject[] = [];
  private readonly parents: number[] = [];
  private readonly indices = new Map<DisplayObject, number>();

  constructor(private readonly library: Library) {}

  encode(root: Container, bytes: Uint8Array): number {
    const data = new Float64Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 8));
    const nodes = this.nodes;
    const parents = this.parents;
    nodes.length = parents.length = 0;
    this.indices.clear();
    nodes.push(root);
    parents.push(-1);

    try {
      for (let i = 0; i < nodes.length; i++) {
        if (vectorFrameBytes(nodes.length) > bytes.byteLength) {
          throw new RangeError("vector snapshot exceeds its slot capacity");
        }

        const o = nodes[i];
        const container = o instanceof Container;
        if (
          (!container && !(o instanceof ShapeObject)) ||
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
            "experimental worker snapshot supports 2D vector shapes and containers only",
          );
        }

        this.indices.set(o, i);
        let character = 0;
        if (o instanceof ShapeObject) {
          if (
            o.morph ||
            o.stale ||
            !o.shape ||
            o.shape.id <= 0 ||
            this.library.characters.get(o.shape.id) !== o.shape ||
            o.shape.layers.some(
              (layer) =>
                layer.meshes?.length ||
                layer.fills.some(({ fill }) => fill.type === "image" || fill.type === "bitmap") ||
                layer.strokes.some(({ line }) => line.fill?.type === "bitmap"),
            )
          ) {
            throw new Error(
              "experimental worker snapshot needs an unchanged shape from its library",
            );
          }

          character = o.shape.id;
        }

        const at = HEADER + i * ROW;
        const m = o.matrix;
        const c = o.colorTransform ?? IDENTITY_COLOR;
        data.set(
          [
            o.serial,
            parents[i],
            character,
            (container ? CONTAINER : 0) | (o.visible ? VISIBLE : 0),
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
      }

      data[0] = VERSION;
      data[1] = nodes.length;

      return end * 8;
    } finally {
      // A failed or blocked publication must not retain removed display objects.
      nodes.length = parents.length = 0;
      this.indices.clear();
    }
  }
}

interface MirrorNode {
  object: Container | ShapeObject;
  character: number;
  filterValues: Float64Array;
}

export class VectorMirror {
  private readonly nodes = new Map<number, MirrorNode>();
  private readonly seen = new Set<number>();
  private readonly rows: (Container | ShapeObject)[] = [];
  private readonly childCounts: number[] = [];
  private readonly masks = new Set<number>();

  constructor(private readonly library: Library) {}

  apply(bytes: Uint8Array): Container {
    if (bytes.byteLength < vectorFrameBytes(1) || bytes.byteLength % 8 !== 0) {
      throw new Error("invalid vector snapshot length");
    }

    const data = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
    const count = data[1];
    if (
      data[0] !== VERSION ||
      !Number.isInteger(count) ||
      count < 1 ||
      vectorFrameBytes(count) > bytes.length
    ) {
      throw new Error("invalid vector snapshot header");
    }

    this.seen.clear();
    this.masks.clear();
    const filters: (readonly Filter[])[] = [];
    const filterEnds: number[] = [];
    let end = HEADER + count * ROW;
    // Validate before touching the mirror, so a rejected frame leaves it intact.
    for (let i = 0; i < count; i++) {
      const at = HEADER + i * ROW;
      const [id, parent, character, flags] = data.subarray(at, at + 4);
      if (
        !Number.isSafeInteger(id) ||
        id < 0 ||
        this.seen.has(id) ||
        !Number.isInteger(flags) ||
        flags < 0 ||
        flags > (CONTAINER | VISIBLE) ||
        !Number.isInteger(parent) ||
        (i === 0 ? parent !== -1 || !(flags & CONTAINER) : parent < 0 || parent >= i) ||
        (i > 0 && !(data[HEADER + parent * ROW + 3] & CONTAINER)) ||
        (flags & CONTAINER
          ? character !== 0
          : !Number.isInteger(character) ||
            character <= 0 ||
            this.library.characters.get(character)?.type !== "shape")
      ) {
        throw new Error("invalid vector snapshot node");
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
        throw new Error("invalid vector snapshot effects");
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
      this.seen.add(id);
    }

    if (end !== data.length) {
      throw new Error("invalid vector snapshot filter tail");
    }

    const rows = this.rows;
    rows.length = 0;
    this.childCounts.length = count;
    this.childCounts.fill(0);

    for (let i = 0; i < count; i++) {
      const at = HEADER + i * ROW;
      const id = data[at];
      const character = data[at + 2];
      let node = this.nodes.get(id);
      if (!node || node.character !== character) {
        node?.object.setMask(null);
        node?.object.maskOf?.setMask(null);
        node?.object.parent?.removeChild(node.object);
        const shape = this.library.characters.get(character);
        node = {
          object:
            character !== 0 && shape?.type === "shape" ? new ShapeObject(shape) : new Container(),
          character,
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

    return rows[0] as Container;
  }
}
