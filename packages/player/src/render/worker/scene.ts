// Experimental complete snapshots of plain vector scenes. Assets stay in a
// library loaded once per thread; scripting objects never enter shared memory.
import { IDENTITY_COLOR, sameColor } from "../../display/color.js";
import {
  BUTTON,
  Container,
  type DisplayObject,
  ShapeObject,
  TRANSFORM,
} from "../../display/display.js";
import type { Library } from "../../display/timeline.js";

const VERSION = 1;
const HEADER = 2;
const ROW = 18;
const CONTAINER = 1;
const VISIBLE = 2;

export const vectorFrameBytes = (nodes: number): number => (HEADER + nodes * ROW) * 8;

export class VectorSnapshot {
  private readonly nodes: DisplayObject[] = [];
  private readonly parents: number[] = [];

  constructor(private readonly library: Library) {}

  encode(root: Container, bytes: Uint8Array): number {
    const data = new Float64Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 8));
    const nodes = this.nodes;
    const parents = this.parents;
    nodes.length = parents.length = 0;
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
          o.mask ||
          o.maskOf ||
          o.clipDepth ||
          o.scrollRect ||
          o.scale9Grid ||
          o.cachedAsBitmap ||
          o.filters.length ||
          o.blendMode !== "normal"
        ) {
          throw new Error(
            "experimental worker snapshot supports plain vector shapes and containers only",
          );
        }

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

      data[0] = VERSION;
      data[1] = nodes.length;

      return vectorFrameBytes(nodes.length);
    } finally {
      // A failed or blocked publication must not retain removed display objects.
      nodes.length = parents.length = 0;
    }
  }
}

interface MirrorNode {
  object: Container | ShapeObject;
  character: number;
}

export class VectorMirror {
  private readonly nodes = new Map<number, MirrorNode>();
  private readonly seen = new Set<number>();
  private readonly rows: (Container | ShapeObject)[] = [];
  private readonly childCounts: number[] = [];

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
      vectorFrameBytes(count) !== bytes.length
    ) {
      throw new Error("invalid vector snapshot header");
    }

    this.seen.clear();
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

      this.seen.add(id);
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
        node?.object.parent?.removeChild(node.object);
        const shape = this.library.characters.get(character);
        node = {
          object:
            character !== 0 && shape?.type === "shape" ? new ShapeObject(shape) : new Container(),
          character,
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
        node.object.parent?.removeChild(node.object);
        this.nodes.delete(id);
      }
    }

    return rows[0] as Container;
  }
}
