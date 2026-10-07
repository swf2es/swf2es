package {
  import flash.display.Sprite;
  import flash.geom.Matrix3D;
  import flash.geom.Utils3D;
  import flash.geom.Vector3D;

  // Matrix3D.pointAt and Utils3D.pointTowards, which Ruffle leaves stubs:
  // the defaults, scales, skews, mirrors, the inputs that leave the matrix
  // as it was, and NaN. Elements are rounded to thousandths, as adl's last
  // bits come from an order of float32 operations the player follows only
  // in part.
  public class PointAt extends Sprite {
    public function PointAt() {
      var id:Matrix3D = new Matrix3D();
      point("default", id, new Vector3D(1, 2, 3));
      point("behind", id, new Vector3D(0, 0, -1));
      point("along x", id, new Vector3D(1, 0, 0));
      point("along up", id, new Vector3D(0, 1, 0));
      point("at itself", id, new Vector3D(0, 0, 0));
      point("w ignored", id, new Vector3D(10, 0, 0, 5));
      point("at x", id, new Vector3D(1, 2, 3), new Vector3D(1, 0, 0));
      point("at 1,1,0", id, new Vector3D(1, 2, 3), new Vector3D(1, 1, 0));
      point("at -z", id, new Vector3D(1, 2, 3), new Vector3D(0, 0, -2));
      point("up x", id, new Vector3D(1, 2, 3), null, new Vector3D(1, 0, 0));
      point("up y", id, new Vector3D(1, 2, 3), null, new Vector3D(0, 1, 0));
      point("documented", id, new Vector3D(1, 2, 3), new Vector3D(0, 0, -1), new Vector3D(0, -1, 0));
      point("at up", id, new Vector3D(4, -2, 7), new Vector3D(1, 0, 0), new Vector3D(0, 0, 1));
      point("not square", id, new Vector3D(3, -1, 2), new Vector3D(0, 2, 1), new Vector3D(1, 1, 1));
      point("parallel", id, new Vector3D(3, 3, 3), new Vector3D(1, 1, 1), new Vector3D(2, 2, 2));
      point("at zero", id, new Vector3D(1, 2, 3), new Vector3D(0, 0, 0));
      point("too far", id, new Vector3D(1e19, 2e19, 3e19));
      point("NaN", id, new Vector3D(NaN, 2, 3));
      point("infinite at", id, new Vector3D(1, 2, 3), new Vector3D(Infinity, 0, 0));

      var m:Matrix3D = new Matrix3D();
      m.appendTranslation(5, 6, 7);
      point("translated", m, new Vector3D(1, 2, 3));
      m = new Matrix3D();
      m.appendRotation(30, Vector3D.X_AXIS);
      m.appendTranslation(1, 1, 1);
      point("turned", m, new Vector3D(1, 2, 3));
      m = new Matrix3D();
      m.appendScale(2, 3, 4);
      point("scaled", m, new Vector3D(1, 2, 3));
      point("scaled at x", m, new Vector3D(1, 2, 3), new Vector3D(1, 0, 0), new Vector3D(0, 1, 0));
      m = new Matrix3D();
      m.appendScale(-2, 3, 4);
      point("mirrored", m, new Vector3D(1, 2, 3));
      point("skewed", new Matrix3D(Vector.<Number>([2, 0, 0, 0, 1, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1])),
        new Vector3D(1, 2, 3));
      point("projection", new Matrix3D(Vector.<Number>([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0.5, 0, 0, 0, 2])),
        new Vector3D(1, 2, 3));
      point("sheared", sheared(), new Vector3D(3, 3, 3));
      point("sheared along", sheared(), new Vector3D(1, -2, 4));
      try {
        new Matrix3D().pointAt(null);
      } catch (e:Error) {
        trace("pointAt null", e);
      }

      var from:Matrix3D = new Matrix3D();
      from.appendRotation(30, Vector3D.Y_AXIS);
      from.appendScale(2, 2, 2);
      from.appendTranslation(-3, 4, 9);
      for each (var p:Number in [-1, 0, 0.25, 0.5, 1, 2]) {
        towards("towards " + p, p, from, new Vector3D(7, -1, 2));
        towards("towards at up " + p, p, from, new Vector3D(7, -1, 2), new Vector3D(0, 1, 0),
          new Vector3D(1, 0, 1));
      }

      towards("towards sheared", 0.3, sheared(), new Vector3D(3, 3, 3));
      towards("towards itself", 0.5, from, new Vector3D(-3, 4, 9));
      towards("towards NaN", 0.5, from, new Vector3D(NaN, 5, 5));
      towards("towards NaN percent", NaN, from, new Vector3D(7, -1, 2));
      trace("a new matrix", Utils3D.pointTowards(1, from, new Vector3D(1, 2, 3)) != from);
      try {
        Utils3D.pointTowards(0.5, null, new Vector3D(1, 2, 3));
      } catch (e:Error) {
        trace("pointTowards null matrix", e);
      }

      try {
        Utils3D.pointTowards(0.5, from, null);
      } catch (e:Error) {
        trace("pointTowards null position", e);
      }
    }

    private function sheared():Matrix3D {
      var m:Matrix3D = new Matrix3D();
      m.appendRotation(40, new Vector3D(1, 2, 3));
      m.appendScale(2, 3, 5);
      m.appendTranslation(1, -2, 4);
      return m;
    }

    private function raw(m:Matrix3D):String {
      var out:Array = [];
      for each (var v:Number in m.rawData) {
        out.push(Math.round(v * 1000) / 1000);
      }

      return out.join(",");
    }

    private function point(label:String, from:Matrix3D, pos:Vector3D, at:Vector3D = null,
      up:Vector3D = null):void {
      var m:Matrix3D = from.clone();
      m.pointAt(pos, at, up);
      trace(label, raw(m));
    }

    private function towards(label:String, percent:Number, from:Matrix3D, pos:Vector3D,
      at:Vector3D = null, up:Vector3D = null):void {
      trace(label, raw(Utils3D.pointTowards(percent, from, pos, at, up)));
    }
  }
}
