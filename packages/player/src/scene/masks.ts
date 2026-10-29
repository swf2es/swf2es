// Masks as the view draws them (RenderView): a mask's draws begun, used
// for what it masks and popped, as stencil markers in the scene list; a
// rectangle, a scroll's or a text's gutter, as the unit quad; and an
// object drawn whole as a mask, fills alone.
import { IDENTITY } from "@swf2es/format";
import {
  type Geometries,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  NORMAL,
  type Rows,
  type SceneList,
  SNAP,
} from "@swf2es/render";
import { BitmapObject } from "../display/bitmapobject.js";
import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject } from "../display/displayobject.js";
import { ShapeObject } from "../display/shapeobject.js";
import { facing } from "../display/shapes.js";
import { StaticTextObject, TextObject } from "../display/textobjects.js";
import type { Parts } from "./parts.js";
import { unsupported } from "./shapes.js";
import { fieldItems, staticItems, type TextOmissions } from "./text.js";
import { placedRow } from "./text-items.js";

export class Masks {
  /** The masks pushed and not yet popped, as each one's first draw and count. */
  private readonly stack: number[] = [];

  constructor(
    private readonly geometries: Geometries,
    private readonly parts: Parts,
  ) {}

  /** A mask begun: its draws follow, till it is used (maskUse); its first entry's index. */
  maskBegin(scene: SceneList): number {
    scene.marker(MASK_BEGIN);
    return scene.length;
  }

  /**
   * The mask begun at entry `first` (maskBegin) used from here, its draws
   * those since. Begun and used around the mask's draws, with no closure:
   * one in the walk kept every number it took in a context made on each
   * call, boxed, though no mask was drawn.
   */
  maskUse(scene: SceneList, first: number): void {
    const count = scene.length - first;
    scene.marker(MASK_USE, first, count);
    this.stack.push(first, count);
  }

  /** The mask pushed last taken out: its draws named again. */
  popMask(scene: SceneList): void {
    const count = this.stack.pop() as number;
    const first = this.stack.pop() as number;
    scene.marker(MASK_POP, first, count);
  }

  /** A rectangle of `o`'s space, x y width height, under its transform (a b c d tx ty), as a mask's draw. */
  rectMask(
    scene: SceneList,
    rows: Rows,
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const quad = this.parts.unitQuad();
    const row = placedRow(
      rows,
      a,
      b,
      c,
      d,
      tx,
      ty,
      { a: width, b: 0, c: 0, d: height, tx: x, ty: y },
      null,
    );
    this.geometries.use(quad.id);
    scene.draw(quad.id, row, NORMAL);
  }

  /**
   * `o` and all in it drawn as a mask, under its parent's transform: fills
   * alone, a drawing's non-zero, glyphs and bitmaps' rectangles, whatever
   * their visibility, as Flash masks by them. `own` says (a b c d tx ty) is
   * already `o`'s own place, as a mask elsewhere on the list is found; else
   * its own matrix is applied. Flags are cleared as the walk clears them.
   */
  walkMask(
    scene: SceneList,
    rows: Rows,
    snapshotting: boolean,
    o: DisplayObject,
    pa: number,
    pb: number,
    pc: number,
    pd: number,
    ptx: number,
    pty: number,
    own: boolean,
  ): void {
    const m = own ? IDENTITY : o.flatPlaced;
    // What would clip a mask's own coverage needs a stencil within the stencil: drawn whole, and counted.
    if (o.mask || o.scroll || o.clipDepth > 0) {
      unsupported.masks++;
    }

    const a = pa * m.a + pc * m.b;
    const b = pb * m.a + pd * m.b;
    const c = pa * m.c + pc * m.d;
    const d = pb * m.c + pd * m.d;
    const tx = pa * m.tx + pc * m.ty + ptx;
    const ty = pb * m.tx + pd * m.ty + pty;
    const shape = o instanceof ShapeObject ? o.drawn() : null;
    const version = o.drawing ? o.drawing.version : 0;
    const layers = o.drawing
      ? facing(o.drawing.layers, a * d - b * c < 0, version)
      : (shape?.layers ?? null);
    // A mask's drawing drawn again lets go of its old layers too.
    if (o.drawing && layers) {
      this.parts.dropUndrawn(o, layers, version);
    }

    // Its row made as its first draw needs it, in place: a closure here kept every number it took
    // in a context made on each call, boxed, as the walk's did.
    let row = -1;
    if (layers) {
      for (let i = 0; i < layers.length; i++) {
        for (const { part, handle } of this.parts.partsOf(layers[i], version, o.drawing !== null)) {
          // A mesh of a bitmap disposed of draws nothing, as it is drawn, and so masks nothing.
          if (part.mesh?.image.disposed) {
            continue;
          }

          this.geometries.use(handle.id);
          if (row < 0) {
            row = rows.add(a, b, c, d, tx, ty, null);
          }

          scene.draw(handle.id, row, NORMAL);
        }
      }
    }

    if (o instanceof TextObject || o instanceof StaticTextObject) {
      const omitted: TextOmissions = { advanced: false, clip: null, clipFrom: 0, clipTo: 0 };
      for (const item of o instanceof TextObject
        ? fieldItems(o, omitted)
        : staticItems(o, omitted)) {
        const geometry = item.kind === "glyph" ? this.parts.glyphGeometry(item.glyph) : null;
        if (item.kind === "glyph" && geometry) {
          const glyphRow = placedRow(rows, a, b, c, d, tx, ty, item.m, null);
          this.geometries.use(geometry.id);
          scene.draw(geometry.id, glyphRow, NORMAL, -1, SNAP);
        }
      }
    }

    const store = o instanceof BitmapObject ? o.store : null;
    if (store && !store.disposed && store.width > 0 && store.height > 0) {
      const quad = this.parts.quad(store.width, store.height);
      this.geometries.use(quad.id);
      if (row < 0) {
        row = rows.add(a, b, c, d, tx, ty, null);
      }

      scene.draw(quad.id, row, NORMAL);
    }

    if (o instanceof Container) {
      for (const child of o.children) {
        this.walkMask(scene, rows, snapshotting, child, a, b, c, d, tx, ty, false);
      }

      if (!snapshotting) {
        o.descendantsDirty = false;
      }
    }

    // A draw for BitmapData leaves them for the stage's.
    if (!snapshotting) {
      o.dirty = CLEAN;
    }
  }
}
