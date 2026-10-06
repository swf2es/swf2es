// flash.geom.PerspectiveProjection: a field of view and a centre, of its
// own or, got from a Transform, of its display object, which it then
// reads and writes. The stage and each SWF's root always have one, back to
// their defaults when set to null. The player stores it; it draws without
// perspective.
import { avm2 } from "@swf2es/runtime";
import type { DisplayObject, Projection } from "../../../display/display.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const f = Math.fround;
const DEGREES_TO_RADIANS = Math.PI / 180;

/** Whether `d` has a projection whatever a script sets: the stage, or a SWF's root. */
export function alwaysProjects(s: Scripting, d: DisplayObject): boolean {
  return d === s.stage || d.loaderInfo !== null;
}

/** The projection `d` has: its own, or the default the stage, a root, or a projection's reader falls back on. */
export function projectionOf(s: Scripting, d: DisplayObject): Projection {
  if (d.projection) {
    return d.projection;
  }

  const root = d !== s.stage && d.loaderInfo !== null;
  return {
    fieldOfView: (55 * Math.PI) / 180,
    centerX: root ? s.stageWidth / 2 : 250,
    centerY: root ? s.stageHeight / 2 : 250,
  };
}

/** The focal length of a field of view in radians over a width, in float32 as Flash's. */
function focalLength(radians: number, width: number): number {
  return f((width / 2) * f(Math.tan((Math.PI - radians) / 2)));
}

export function perspectiveProjectionNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  /** The stage's projection and one of its own measure 500 wide; any other object's, the stage's width. */
  const width = (d: DisplayObject | null): number => (d && d !== s.stage ? s.stageWidth : 500);

  const focalOf = (o: { $display: DisplayObject | null; $fieldOfView: number }): number =>
    o.$display
      ? focalLength(projectionOf(s, o.$display).fieldOfView, width(o.$display))
      : focalLength(o.$fieldOfView * DEGREES_TO_RADIANS, 500);

  class PerspectiveProjectionNatives {
    declare $display: DisplayObject | null;
    /** Its own field of view, in degrees, and centre, while it has no display object. */
    declare $fieldOfView: number;
    declare $centerX: number;
    declare $centerY: number;

    "flash.geom:PerspectiveProjection::ctor"(): void {
      this.$display = null;
      this.$fieldOfView = 55;
      this.$centerX = 250;
      this.$centerY = 250;
    }

    get fieldOfView(): number {
      if (this.$display) {
        return (projectionOf(s, this.$display).fieldOfView * 180) / Math.PI;
      }

      return this.$fieldOfView;
    }

    set fieldOfView(v: Value) {
      const degrees = s.rt.toNumber(v);
      if (!(degrees > 0 && degrees < 180)) {
        throw s.rt.error("ArgumentError", 2182);
      }

      if (this.$display) {
        update(this.$display, { fieldOfView: (degrees * Math.PI) / 180 });
      } else {
        this.$fieldOfView = degrees;
      }
    }

    get focalLength(): number {
      return focalOf(this);
    }

    set focalLength(v: Value) {
      const length = s.rt.toNumber(v);
      if (!(length > 0)) {
        throw s.rt.error("ArgumentError", 2186, length);
      }

      const radians = Math.atan(width(this.$display) / 2 / length) * 2;
      if (this.$display) {
        update(this.$display, { fieldOfView: radians });
      } else {
        this.$fieldOfView = (radians * 180) / Math.PI;
      }
    }

    get projectionCenter(): AsObject {
      const p = this.$display ? projectionOf(s, this.$display) : null;
      return s.rt.construct(
        s.rt.classNamed("flash.geom::Point"),
        p ? p.centerX : this.$centerX,
        p ? p.centerY : this.$centerY,
      ) as AsObject;
    }

    set projectionCenter(v: Value) {
      if (v === null || v === undefined) {
        throw s.rt.error("TypeError", 2007, "projectionCenter");
      }

      const point = v as AsObject;
      const x = s.rt.toNumber(s.rt.getProperty(point, s.rt.publicName("x")));
      const y = s.rt.toNumber(s.rt.getProperty(point, s.rt.publicName("y")));
      if (this.$display) {
        update(this.$display, { centerX: x, centerY: y });
      } else {
        this.$centerX = x;
        this.$centerY = y;
      }
    }

    toMatrix3D(): AsObject {
      const length = focalOf(this);
      const m = s.rt.construct(s.rt.classNamed("flash.geom::Matrix3D")) as AsObject;
      (m.$matrix3D as Float32Array).set([length, 0, 0, 0, 0, length, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]);
      return m;
    }
  }

  /** A change to a display object's projection, made from its current one. */
  const update = (d: DisplayObject, change: Partial<Projection>): void => {
    d.projection = { ...projectionOf(s, d), ...change };
  };

  avm2.registerNativeClass(
    natives,
    "flash.geom::PerspectiveProjection",
    PerspectiveProjectionNatives,
  );
  return natives;
}

/** A PerspectiveProjection of `d`'s, which reads and writes `d`'s. */
export function projectionObject(s: Scripting, d: DisplayObject): AsObject {
  const o = s.rt.construct(s.rt.classNamed("flash.geom::PerspectiveProjection")) as AsObject;
  o.$display = d;
  return o;
}

/** What setting `o` on a transform gives: a copy of its values, in radians. */
export function projectionFrom(s: Scripting, o: AsObject): Projection {
  if (o.$display) {
    return { ...projectionOf(s, o.$display) };
  }

  return {
    fieldOfView: (o.$fieldOfView * Math.PI) / 180,
    centerX: o.$centerX,
    centerY: o.$centerY,
  };
}
