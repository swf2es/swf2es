// flash.display.DisplayObject: allocated with a player display object as its
// other face, and its properties read and written through it.
import type { Matrix } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { bounds, boundsIn, hitsObject, hitsPoint, toStage } from "../../../bounds.js";
import {
  ButtonObject,
  CONTENT,
  type DisplayObject,
  TextObject,
  TRANSFORM,
} from "../../../display.js";
import { copyFilter } from "../../../filters.js";
import { apply, invert, type Rect, transformRect } from "../../../geometry.js";
import type { Scripting } from "../../../scripting.js";
import { copyMap, filterClassName, filterKindOf, recordOf } from "../filters/filters.js";
import { colorOf, matrixOf } from "../geom/Transform.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const MATRIX_NAME = avm2.qname(avm2.publicNs, "matrix");
const COLOR_NAME = avm2.qname(avm2.publicNs, "colorTransform");
const name = (n: string) => avm2.qname(avm2.publicNs, n);

/** The blend modes Flash accepts; another is ArgumentError #2008. */
const BLEND_MODES = new Set([
  "normal",
  "layer",
  "multiply",
  "screen",
  "lighten",
  "darken",
  "difference",
  "add",
  "subtract",
  "invert",
  "alpha",
  "erase",
  "overlay",
  "hardlight",
  "shader",
]);

/** A new flash.geom.Rectangle with `r`'s values, as Flash hands out copies, or null for none. */
function rectangleCopy(s: Scripting, r: AsObject | null): Value {
  if (!r) {
    return null;
  }

  return s.rt.construct(
    s.rt.classNamed("flash.geom::Rectangle"),
    ...["x", "y", "width", "height"].map((k) => s.rt.getProperty(r, name(k))),
  );
}

/** The nearest whole number, a half to the even one. */
function halfEven(v: number): number {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function point(s: Scripting, x: number, y: number): Value {
  return s.rt.construct(s.rt.classNamed("flash.geom::Point"), x, y);
}

/** Flash keeps positions in twips, so what it reports of bounds is a multiple of a twentieth. */
const twips = (v: number) => Math.round(v * 20) / 20;

/** The object's width and height in its parent's space, or what that would be for one with no parent: its bounds through its own matrix. */
function size(d: DisplayObject): [number, number] {
  const r = transformRect(bounds(d, true) ?? { xMin: 0, yMin: 0, xMax: 0, yMax: 0 }, d.placed);
  return [twips(r.xMax - r.xMin), twips(r.yMax - r.yMin)];
}

function rectangle(s: Scripting, r: Rect): Value {
  return s.rt.construct(
    s.rt.classNamed("flash.geom::Rectangle"),
    twips(r.xMin),
    twips(r.yMin),
    twips(r.xMax - r.xMin),
    twips(r.yMax - r.yMin),
  );
}

/**
 * A text field's x and y are its box's corner, not its origin: its
 * DefineEditText bounds' corner, scaled, added to where it is placed, as
 * Flash and Ruffle read and set them. A box authored inset from its origin
 * so moves to where a script puts it. The offset is whole twips, cut
 * toward zero as Ruffle's is, and none for a NaN scale.
 */
function fieldOffset(d: DisplayObject): [number, number] {
  if (!(d instanceof TextObject)) {
    return [0, 0];
  }

  const twips = (v: number) => Math.trunc(v) || 0;
  return [twips(d.scaleX * d.left * 20), twips(d.scaleY * d.top * 20)];
}

/**
 * `at` in pixels moved by `offset` in twips, summed in twips: Flash's
 * positions are whole twips, without a pixel sum's noise.
 */
function withOffset(at: number, offset: number): number {
  return offset === 0 ? at : (at * 20 + offset) / 20;
}

/** The display object `o` is the face of. */
export function displayOf(o: avm2.AsObject): DisplayObject {
  return o.$display;
}

export function displayObjectHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return {
    "flash.display::DisplayObject": {
      // The one the player has pending, when it constructs a timeline child's
      // class; else one for the class, for a `new` from a script.
      create: (traits) => {
        const o = Object.create(traits.proto);
        const made = s.pending === null;
        const display = s.pending ?? s.displayFor(traits);
        s.pending = null;
        // Flash names each display object without a name of its own as it
        // is made, instance1, instance2, ..., the stage aside.
        if (display.name === "" && display !== s.stage) {
          display.name = `instance${++s.instances}`;
        }

        o.$display = display;
        display.object = o;
        if (made) {
          s.made(display);
        }

        return o;
      },
    },
  };
}

/** Move a display object, by a copy of its matrix, and have it drawn again. */
function transform(d: DisplayObject, change: (m: Matrix) => void): void {
  const m = { ...d.matrix };
  change(m);
  d.matrix = m;
  d.scripted = true;
  d.invalidate(TRANSFORM);
}

const IDENTITY_COLOR = { rMul: 1, gMul: 1, bMul: 1, aMul: 1, rAdd: 0, gAdd: 0, bAdd: 0, aAdd: 0 };

/** The root `d` is under, or is: the nearest display object up from it that carries a LoaderInfo; null under none, as for one a script made and did not add. */
export function rootOf(d: DisplayObject): DisplayObject | null {
  for (let o: DisplayObject | null = d; o; o = o.parent) {
    if (o.loaderInfo) {
      return o;
    }
  }

  return null;
}

/** Whether `d` is on the display list: under the stage. */
export function onStage(s: Scripting, d: DisplayObject): boolean {
  for (let o: DisplayObject | null = d; o; o = o.parent) {
    if (o === s.stage) {
      return true;
    }
  }

  return false;
}

export function displayObjectNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  // How the natives are written: each runs with the AS3 object as `this`,
  // whose $display is the player's display object (registerNativeClass).
  class DisplayObjectNatives {
    declare $display: DisplayObject;
    declare $transform: AsObject | undefined;
    declare $cacheAsBitmap: boolean | undefined;
    declare $cacheAsBitmapMatrix: Value;
    declare $metaData: Value;
    declare $opaqueBackground: Value;
    declare $scale9Grid: AsObject | null | undefined;
    declare $accessibilityProperties: Value;

    get name(): string {
      return this.$display.name;
    }

    /** Flash refuses a timeline-placed object's name, so a script's touch there never marks it (the `replaces` case). */
    set name(v: Value) {
      if (this.$display.placeFrame > 0) {
        throw s.rt.error("flash.errors::IllegalOperationError", 2078);
      }

      this.$display.name = String(v);
    }

    get visible(): boolean {
      return this.$display.visible;
    }

    // Set to what it was, visible, mask and cacheAsBitmap are no touch in Flash (the `replaces` case).
    set visible(v: Value) {
      if (this.$display.visible !== !!v) {
        this.$display.scripted = true;
      }

      this.$display.visible = !!v;
      this.$display.invalidate(TRANSFORM);
      if (!v) {
        this.$display.focusDrop?.(this.$display);
      }
    }

    get x(): number {
      return withOffset(this.$display.matrix.tx, fieldOffset(this.$display)[0]);
    }

    // A NaN position is 0, as Flash has it (the corpus's `displayobject_invalid_floats`).
    set x(v: Value) {
      const offset = fieldOffset(this.$display)[0];
      transform(this.$display, (m) => {
        m.tx = withOffset(Number(v) || 0, -offset);
      });
    }

    get y(): number {
      return withOffset(this.$display.matrix.ty, fieldOffset(this.$display)[1]);
    }

    set y(v: Value) {
      const offset = fieldOffset(this.$display)[1];
      transform(this.$display, (m) => {
        m.ty = withOffset(Number(v) || 0, -offset);
      });
    }

    // The scales and the rotation are the display object's own, kept apart from the matrix as Flash keeps them.
    get scaleX(): number {
      return this.$display.scaleX;
    }

    set scaleX(v: Value) {
      this.$display.scripted = true;
      this.$display.setScaleX(Number(v));
    }

    get scaleY(): number {
      return this.$display.scaleY;
    }

    set scaleY(v: Value) {
      this.$display.scripted = true;
      this.$display.setScaleY(Number(v));
    }

    get rotation(): number {
      return this.$display.rotation;
    }

    set rotation(v: Value) {
      this.$display.scripted = true;
      this.$display.setRotation(Number(v));
    }

    get alpha(): number {
      return this.$display.colorTransform?.aMul ?? 1;
    }

    set alpha(v: Value) {
      const d = this.$display;
      d.scripted = true;
      d.colorTransform = { ...(d.colorTransform ?? IDENTITY_COLOR), aMul: Number(v) };
      d.invalidate(TRANSFORM);
    }

    // A button's state has none: the button is no container to a script.
    get parent(): Value {
      const parent = this.$display.parent;
      return parent instanceof ButtonObject ? null : (parent?.object ?? null);
    }

    get stage(): Value {
      return onStage(s, this.$display) ? (s.stage?.object ?? null) : null;
    }

    /** The root of the SWF this is in, main or loaded; null off the display list, as Flash has it. */
    get root(): Value {
      return rootOf(this.$display)?.object ?? null;
    }

    /** The LoaderInfo of the SWF this is in; null off the display list. */
    // The stage's is the main SWF's, as Flash's.
    get loaderInfo(): Value {
      if (this.$display === s.stage) {
        return s.root?.loaderInfo ?? null;
      }

      return rootOf(this.$display)?.loaderInfo ?? null;
    }

    get mouseX(): number {
      const m = invert(toStage(this.$display, s.stage));
      return m ? apply(m, s.mouseStageX, s.mouseStageY)[0] : 0;
    }

    get mouseY(): number {
      const m = invert(toStage(this.$display, s.stage));
      return m ? apply(m, s.mouseStageX, s.mouseStageY)[1] : 0;
    }

    /** The bounds through the object's own matrix, in its parent's space. */
    get width(): number {
      return size(this.$display)[0];
    }

    /**
     * scaleX becomes the value over the object's untransformed width, as
     * Flash sets it: positive whatever the sign was, from a scale of 0 as
     * from any other, and not at all for a negative value or no width.
     * Under a turn or skew, where Flash's rule is more involved, the
     * current scale is adjusted in proportion instead. The width is
     * Flash's, in twips: a drawing thinner than one is no width (the
     * corpus's `nan_scale`).
     */
    set width(v: Value) {
      const value = Number(v);
      if (!(value >= 0)) {
        return;
      }

      const d = this.$display;
      // A TextField's is its field's, resized at its scale, the text as it was.
      if (d instanceof TextObject) {
        d.width = value / (Math.abs(d.scaleX) || 1);
        d.invalidate(CONTENT);
        d.fit();
        return;
      }

      d.scripted = true;
      const r = bounds(d, true);
      const base = r ? twips(r.xMax - r.xMin) : 0;
      if (d.rotation === 0 && d.skew === 0) {
        if (base > 0) {
          d.setScaleX(value / base);
        }
      } else {
        const current = size(d)[0];
        if (current > 0) {
          d.setScaleX((d.scaleX * value) / current);
        }
      }
    }

    get height(): number {
      return size(this.$display)[1];
    }

    set height(v: Value) {
      const value = Number(v);
      if (!(value >= 0)) {
        return;
      }

      const d = this.$display;
      // A TextField's is its field's, resized at its scale, the text as it was.
      if (d instanceof TextObject) {
        d.height = value / (Math.abs(d.scaleY) || 1);
        d.invalidate(CONTENT);
        d.fit();
        return;
      }

      d.scripted = true;
      const r = bounds(d, true);
      const base = r ? twips(r.yMax - r.yMin) : 0;
      if (d.rotation === 0 && d.skew === 0) {
        if (base > 0) {
          d.setScaleY(value / base);
        }
      } else {
        const current = size(d)[1];
        if (current > 0) {
          d.setScaleY((d.scaleY * value) / current);
        }
      }
    }

    getBounds(target: Value): Value {
      return rectangle(
        s,
        boundsIn(this.$display, (target as AsObject | null)?.$display ?? null, s.stage, true),
      );
    }

    getRect(target: Value): Value {
      return rectangle(
        s,
        boundsIn(this.$display, (target as AsObject | null)?.$display ?? null, s.stage, false),
      );
    }

    /** hitTestPoint(x, y, shapeFlag) asks with `point`; hitTestObject(other) without. */
    "flash.display:DisplayObject::_hitTest"(
      point: Value,
      x: Value,
      y: Value,
      shape: Value,
      other: Value,
    ): boolean {
      if (point) {
        return hitsPoint(this.$display, Number(x), Number(y), !!shape, s.root);
      }

      const o = (other as AsObject | null)?.$display;
      return o ? hitsObject(this.$display, o, s.stage) : false;
    }

    get blendMode(): string {
      return this.$display.blendMode;
    }

    set blendMode(v: Value) {
      const mode = s.rt.toString(v);
      if (!BLEND_MODES.has(mode)) {
        throw s.rt.error("ArgumentError", 2008, "blendMode");
      }

      this.$display.scripted = true;
      this.$display.setBlendMode(mode);
    }

    get cacheAsBitmap(): boolean {
      return this.$cacheAsBitmap ?? false;
    }

    set cacheAsBitmap(v: Value) {
      if ((this.$cacheAsBitmap ?? false) !== !!v) {
        this.$display.scripted = true;
      }

      this.$cacheAsBitmap = !!v;
    }

    get cacheAsBitmapMatrix(): Value {
      return this.$cacheAsBitmapMatrix ?? null;
    }

    set cacheAsBitmapMatrix(v: Value) {
      this.$cacheAsBitmapMatrix = v;
    }

    /** Copies each time, as Flash gives them: `filters === filters` is false, and a filter changed is not the object's. */
    get filters(): Value {
      return s.rt.array(
        this.$display.filters.map((f) => {
          const o = s.rt.construct(s.rt.classNamed(filterClassName(f.kind))) as AsObject;
          o.$filter = copyFilter(f);
          return o;
        }),
      );
    }

    set filters(v: Value) {
      this.$display.scripted = true;
      const list = v ? (((v as AsObject).$a as Value[] | undefined) ?? []) : [];
      const filters = list.map((item) => {
        const kind = item && typeof item === "object" ? filterKindOf(s.rt, item as AsObject) : null;
        if (!kind) {
          throw s.rt.error("ArgumentError", 2005, 0, "Filter");
        }

        const f = copyFilter(recordOf(item as AsObject, kind));
        // A displacement map's pixels are taken as they are, as Flash takes
        // them: the object draws with those, whatever is drawn on the map
        // after, till its filters are set again; the map itself it keeps.
        if (f.kind === "displacementMap" && f.mapBitmap) {
          f.mapSnapshot = copyMap(s, f.mapBitmap);
        }

        return f;
      });
      this.$display.filters = filters;
      this.$display.invalidate(TRANSFORM);
    }

    get mask(): Value {
      return this.$display.mask?.object ?? null;
    }

    set mask(v: Value) {
      const mask = (v as AsObject | null)?.$display ?? null;
      if (this.$display.mask !== mask) {
        this.$display.scripted = true;
      }

      this.$display.setMask(mask);
    }

    get metaData(): Value {
      return this.$metaData ?? null;
    }

    set metaData(v: Value) {
      this.$metaData = v;
    }

    get opaqueBackground(): Value {
      return this.$opaqueBackground ?? null;
    }

    set opaqueBackground(v: Value) {
      this.$display.scripted = true;
      this.$opaqueBackground = v === null || v === undefined ? null : s.rt.toUint(v);
    }

    get scale9Grid(): Value {
      return rectangleCopy(s, this.$scale9Grid ?? null);
    }

    set scale9Grid(v: Value) {
      this.$display.scripted = true;
      this.$scale9Grid = v ? (rectangleCopy(s, v as AsObject) as AsObject) : null;
    }

    get scrollRect(): Value {
      const r = this.$display.scrollRect;
      return r ? rectangle(s, r) : null;
    }

    /** Each edge to a whole pixel, a half to even, as Flash keeps them; drawn from the next render. */
    set scrollRect(v: Value) {
      this.$display.scripted = true;
      let r: Rect | null = null;
      if (v) {
        const [x, y, w, h] = ["x", "y", "width", "height"].map((k) =>
          Number(s.rt.getProperty(v as AsObject, name(k))),
        );
        r = { xMin: halfEven(x), yMin: halfEven(y), xMax: halfEven(x + w), yMax: halfEven(y + h) };
      }

      this.$display.scrollRect = r;
      s.scrolled.add(this.$display);
    }

    get accessibilityProperties(): Value {
      return this.$accessibilityProperties ?? null;
    }

    set accessibilityProperties(v: Value) {
      this.$accessibilityProperties = v;
    }

    /** A point of this object's space in the stage's: through the matrices up to the stage. */
    localToGlobal(p: Value): Value {
      const m = toStage(this.$display, s.stage);
      const x = Number(s.rt.getProperty(p as AsObject, name("x")));
      const y = Number(s.rt.getProperty(p as AsObject, name("y")));
      return point(s, m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty);
    }

    /** A point of the stage's space in this object's: the inverse of the way up. */
    globalToLocal(p: Value): Value {
      const m = toStage(this.$display, s.stage);
      const x = Number(s.rt.getProperty(p as AsObject, name("x"))) - m.tx;
      const y = Number(s.rt.getProperty(p as AsObject, name("y"))) - m.ty;
      const det = m.a * m.d - m.b * m.c;
      return point(s, (m.d * x - m.c * y) / det, (m.a * y - m.b * x) / det);
    }

    /** One Transform per display object, made when first asked for. */
    get transform(): Value {
      if (!this.$transform) {
        this.$transform = s.rt.construct(
          s.rt.classNamed("flash.geom::Transform"),
          this,
        ) as AsObject;
      }

      return this.$transform;
    }

    /** Takes the given Transform's matrix and color transform, not the object. */
    set transform(v: Value) {
      if (v) {
        const t = v as AsObject;
        this.$display.setMatrix(matrixOf(s, s.rt.getProperty(t, MATRIX_NAME) as AsObject));
        this.$display.colorTransform = colorOf(s, s.rt.getProperty(t, COLOR_NAME) as AsObject);
        this.$display.scripted = true;
        this.$display.invalidate(TRANSFORM);
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.display::DisplayObject", DisplayObjectNatives);
  return natives;
}
