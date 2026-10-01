// flash.display.DisplayObject: allocated with a player display object as its
// other face, and its properties read and written through it.
import type { Matrix } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { boundsIn, hitsObject, hitsPoint, toStage } from "../../../bounds.js";
import { type DisplayObject, TRANSFORM } from "../../../display.js";
import type { Rect } from "../../../geometry.js";
import type { Scripting } from "../../../scripting.js";
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

function point(s: Scripting, x: number, y: number): Value {
  return s.rt.construct(s.rt.classNamed("flash.geom::Point"), x, y);
}

/** Flash keeps positions in twips, so what it reports of bounds is a multiple of a twentieth. */
const twips = (v: number) => Math.round(v * 20) / 20;

/** The object's width and height in its parent's space: its bounds through its matrix. */
function size(s: Scripting, d: DisplayObject): [number, number] {
  const r = boundsIn(d, d.parent, s.stage, true);
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

const DEG = 180 / Math.PI;

/** Change a display object's transform, by a copy, and have it drawn again. */
function transform(d: DisplayObject, change: (m: Matrix) => void): void {
  const m = { ...d.matrix };
  change(m);
  d.matrix = m;
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
    declare $blendMode: string | undefined;
    declare $cacheAsBitmap: boolean | undefined;
    declare $cacheAsBitmapMatrix: Value;
    declare $filters: Value[] | undefined;
    declare $mask: Value;
    declare $metaData: Value;
    declare $opaqueBackground: Value;
    declare $scale9Grid: AsObject | null | undefined;
    declare $scrollRect: AsObject | null | undefined;
    declare $accessibilityProperties: Value;

    get name(): string {
      return this.$display.name;
    }

    set name(v: Value) {
      this.$display.name = String(v);
    }

    get visible(): boolean {
      return this.$display.visible;
    }

    set visible(v: Value) {
      this.$display.visible = !!v;
      this.$display.invalidate(TRANSFORM);
    }

    get x(): number {
      return this.$display.matrix.tx;
    }

    set x(v: Value) {
      transform(this.$display, (m) => {
        m.tx = Number(v);
      });
    }

    get y(): number {
      return this.$display.matrix.ty;
    }

    set y(v: Value) {
      transform(this.$display, (m) => {
        m.ty = Number(v);
      });
    }

    get scaleX(): number {
      return Math.hypot(this.$display.matrix.a, this.$display.matrix.b);
    }

    set scaleX(v: Value) {
      transform(this.$display, (m) => {
        const r = Math.atan2(m.b, m.a);
        m.a = Number(v) * Math.cos(r);
        m.b = Number(v) * Math.sin(r);
      });
    }

    get scaleY(): number {
      return Math.hypot(this.$display.matrix.c, this.$display.matrix.d);
    }

    set scaleY(v: Value) {
      transform(this.$display, (m) => {
        const r = Math.atan2(-m.c, m.d);
        m.c = -Number(v) * Math.sin(r);
        m.d = Number(v) * Math.cos(r);
      });
    }

    get rotation(): number {
      return Math.atan2(this.$display.matrix.b, this.$display.matrix.a) * DEG;
    }

    set rotation(v: Value) {
      transform(this.$display, (m) => {
        const r = (Number(v) / DEG) % (2 * Math.PI);
        const sx = Math.hypot(m.a, m.b);
        const sy = Math.hypot(m.c, m.d);
        m.a = sx * Math.cos(r);
        m.b = sx * Math.sin(r);
        m.c = -sy * Math.sin(r);
        m.d = sy * Math.cos(r);
      });
    }

    get alpha(): number {
      return this.$display.colorTransform?.aMul ?? 1;
    }

    set alpha(v: Value) {
      const d = this.$display;
      d.colorTransform = { ...(d.colorTransform ?? IDENTITY_COLOR), aMul: Number(v) };
      d.invalidate(TRANSFORM);
    }

    get parent(): Value {
      return this.$display.parent?.object ?? null;
    }

    get stage(): Value {
      return onStage(s, this.$display) ? (s.stage?.object ?? null) : null;
    }

    /** The root of the SWF this is in, main or loaded; null off the display list, as Flash has it. */
    get root(): Value {
      return rootOf(this.$display)?.object ?? null;
    }

    /** The LoaderInfo of the SWF this is in; null off the display list. */
    get loaderInfo(): Value {
      return rootOf(this.$display)?.loaderInfo ?? null;
    }

    get mouseX(): number {
      return 0;
    }

    get mouseY(): number {
      return 0;
    }

    /** The bounds through the object's own matrix, in its parent's space. */
    get width(): number {
      return size(s, this.$display)[0];
    }

    /** Scaled so that the bounds come to the value; left as it is when they have no extent. */
    set width(v: Value) {
      const current = size(s, this.$display)[0];
      if (current > 0) {
        const value = Number(v);
        transform(this.$display, (m) => {
          m.a *= value / current;
          m.b *= value / current;
        });
      }
    }

    get height(): number {
      return size(s, this.$display)[1];
    }

    set height(v: Value) {
      const current = size(s, this.$display)[1];
      if (current > 0) {
        const value = Number(v);
        transform(this.$display, (m) => {
          m.c *= value / current;
          m.d *= value / current;
        });
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
      return this.$blendMode ?? "normal";
    }

    set blendMode(v: Value) {
      const mode = s.rt.toString(v);
      if (!BLEND_MODES.has(mode)) {
        throw s.rt.error("ArgumentError", 2008, "blendMode");
      }

      this.$blendMode = mode;
    }

    get cacheAsBitmap(): boolean {
      return this.$cacheAsBitmap ?? false;
    }

    set cacheAsBitmap(v: Value) {
      this.$cacheAsBitmap = !!v;
    }

    get cacheAsBitmapMatrix(): Value {
      return this.$cacheAsBitmapMatrix ?? null;
    }

    set cacheAsBitmapMatrix(v: Value) {
      this.$cacheAsBitmapMatrix = v;
    }

    /** A copy each time, as Flash: `filters === filters` is false. Nothing draws them yet. */
    get filters(): Value {
      return s.rt.array([...(this.$filters ?? [])]);
    }

    set filters(v: Value) {
      this.$filters = v ? [...(((v as AsObject).$a as Value[] | undefined) ?? [])] : [];
    }

    get mask(): Value {
      return this.$mask ?? null;
    }

    set mask(v: Value) {
      this.$mask = v;
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
      this.$opaqueBackground = v === null || v === undefined ? null : s.rt.toUint(v);
    }

    get scale9Grid(): Value {
      return rectangleCopy(s, this.$scale9Grid ?? null);
    }

    set scale9Grid(v: Value) {
      this.$scale9Grid = v ? (rectangleCopy(s, v as AsObject) as AsObject) : null;
    }

    get scrollRect(): Value {
      return rectangleCopy(s, this.$scrollRect ?? null);
    }

    set scrollRect(v: Value) {
      this.$scrollRect = v ? (rectangleCopy(s, v as AsObject) as AsObject) : null;
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
        this.$display.matrix = matrixOf(s, s.rt.getProperty(t, MATRIX_NAME) as AsObject);
        this.$display.colorTransform = colorOf(s, s.rt.getProperty(t, COLOR_NAME) as AsObject);
        this.$display.invalidate(TRANSFORM);
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.display::DisplayObject", DisplayObjectNatives);
  return natives;
}
