package {
  import flash.display.Sprite;
  import flash.geom.Matrix;
  import flash.geom.Matrix3D;
  import flash.geom.PerspectiveProjection;
  import flash.geom.Point;
  import flash.geom.Utils3D;
  import flash.geom.Vector3D;

  // A display object's 3D properties, its matrix3D and perspective
  // projection, and Matrix3D's and Utils3D's arithmetic. Values the
  // float32 decomposition makes noisy are rounded.
  public class ThreeD extends Sprite {
    public function ThreeD() {
      properties();
      matrices();
      projections();
      arithmetic();
    }

    private function r(n:Number):Number {
      return Math.round(n * 10000) / 10000;
    }

    private function raw(m:Matrix3D):String {
      if (!m) {
        return "null";
      }

      var out:Array = [];
      for each (var v:Number in m.rawData) {
        out.push(r(v));
      }

      return out.join(",");
    }

    private function props(label:String, s:Sprite):void {
      trace(label, s.x, s.y, s.z, r(s.scaleX), r(s.scaleY), r(s.scaleZ), r(s.rotation),
        r(s.rotationX), r(s.rotationY), r(s.rotationZ));
      trace("  matrix", s.transform.matrix, "matrix3D", raw(s.transform.matrix3D));
    }

    private function properties():void {
      var s:Sprite = new Sprite();
      props("new", s);
      s.z = 0;
      props("z = 0", s);
      s.z = 50;
      props("z = 50", s);
      s.transform.matrix3D = null;
      props("matrix3D = null", s);

      var t:Sprite = new Sprite();
      t.x = 10;
      t.y = 20;
      t.scaleX = 2;
      t.rotationY = 90;
      props("rotationY = 90", t);
      t.rotationX = 400;
      props("rotationX = 400", t);
      t.rotation = -200;
      props("rotation = -200", t);
      t.scaleZ = 3;
      props("scaleZ = 3", t);
      t.x = 5;
      props("x = 5", t);
      t.z = NaN;
      t.rotationX = NaN;
      props("NaN", t);
      t.transform.matrix = new Matrix(1, 0, 0, 1, 7, 8);
      props("matrix set", t);

      var u:Sprite = new Sprite();
      u.transform.matrix = new Matrix(2, 3, 4, 5, 6, 7);
      u.transform.matrix = null;
      props("matrix = null", u);
      u.x = 30;
      trace("  x = 30", raw(u.transform.matrix3D));
      u.transform.matrix3D = new Matrix3D(Vector.<Number>([2, 3, 0, 0, 4, 5, 0, 0, 0, 0, 1, 0, 6, 7, 8, 1]));
      trace("  skewed matrix3D", raw(u.transform.matrix3D), r(u.scaleX), r(u.scaleY), r(u.scaleZ),
        r(u.rotationX), r(u.rotationZ));
      u.y = 1;
      trace("  y = 1", raw(u.transform.matrix3D));

      var v:Sprite = new Sprite();
      v.transform = u.transform;
      trace("copied", raw(v.transform.matrix3D), v.transform.matrix);

      var w:Sprite = new Sprite();
      w.rotationZ = 30;
      props("rotationZ = 30", w);
      var x:Sprite = new Sprite();
      x.scaleZ = 1;
      props("scaleZ = 1", x);
    }

    private function matrices():void {
      var parent:Sprite = new Sprite();
      var child:Sprite = new Sprite();
      parent.addChild(child);
      parent.x = 100;
      child.z = 40;
      child.rotationY = 90;
      trace("relative to parent", raw(child.transform.getRelativeMatrix3D(parent)));
      trace("relative to itself", raw(child.transform.getRelativeMatrix3D(child)));
      trace("2D relative", parent.transform.getRelativeMatrix3D(child));
      try {
        child.transform.getRelativeMatrix3D(null);
      } catch (e:Error) {
        trace("relative to null", e);
      }
    }

    private function projection(label:String, p:PerspectiveProjection):void {
      if (!p) {
        trace(label, p);
        return;
      }

      // A field of view from a focal length goes through atan, whose last bit Flash's C library decides.
      trace(label, r(p.fieldOfView), p.focalLength, p.projectionCenter);
    }

    private function projections():void {
      var p:PerspectiveProjection = new PerspectiveProjection();
      projection("new", p);
      p.fieldOfView = 90;
      projection("fieldOfView = 90", p);
      p.focalLength = 1000;
      projection("focalLength = 1000", p);
      p.projectionCenter = new Point(10, 20);
      projection("center", p);
      trace("toMatrix3D", raw(p.toMatrix3D()));
      try {
        p.fieldOfView = 180;
      } catch (e:Error) {
        trace("fieldOfView = 180", e);
      }
      try {
        p.focalLength = 0;
      } catch (e:Error) {
        trace("focalLength = 0", e);
      }

      var s:Sprite = new Sprite();
      projection("sprite", s.transform.perspectiveProjection);
      s.transform.perspectiveProjection = p;
      var q:PerspectiveProjection = s.transform.perspectiveProjection;
      trace("same object", q == s.transform.perspectiveProjection);
      trace("set", r(q.fieldOfView), q.projectionCenter);
      q.projectionCenter = new Point(1, 2);
      trace("through the transform", s.transform.perspectiveProjection.projectionCenter, p.projectionCenter);
      s.transform.perspectiveProjection = null;
      projection("null", s.transform.perspectiveProjection);
    }

    private function arithmetic():void {
      var m:Matrix3D = new Matrix3D();
      m.appendScale(2, 3, 4);
      m.appendRotation(90, Vector3D.Z_AXIS);
      m.appendTranslation(1, 2, 3);
      trace("composed", raw(m));
      trace("determinant", r(m.determinant), "position", m.position);
      trace("transformVector", m.transformVector(new Vector3D(1, 1, 1)));
      trace("deltaTransformVector", m.deltaTransformVector(new Vector3D(1, 1, 1)));
      var parts:Vector.<Vector3D> = m.decompose();
      trace("decompose", parts[0], r(parts[1].z), r(parts[2].x), r(parts[2].y), r(parts[2].z));
      var n:Matrix3D = new Matrix3D();
      trace("recompose", n.recompose(parts), raw(n));
      trace("recompose short", n.recompose(parts.slice(0, 2)));
      var inverse:Matrix3D = m.clone();
      trace("invert", inverse.invert(), raw(inverse));
      inverse.append(m);
      trace("inverse times m", raw(inverse));
      var o:Matrix3D = new Matrix3D();
      o.prependTranslation(5, 0, 0);
      o.prependScale(2, 2, 2);
      o.prependRotation(90, Vector3D.X_AXIS);
      trace("prepended", raw(o));
      var out:Vector.<Number> = new Vector.<Number>();
      o.transformVectors(Vector.<Number>([1, 2, 3, 4, 5]), out);
      trace("transformVectors", out);
      trace("interpolate", raw(Matrix3D.interpolate(new Matrix3D(), m, 0.5)));
      try {
        o.appendScale(0, 1, 1);
      } catch (e:Error) {
        trace("appendScale(0)", e);
      }
      try {
        o.decompose("sideways");
      } catch (e:Error) {
        trace("decompose(sideways)", e);
      }
      try {
        o.append(null);
      } catch (e:Error) {
        trace("append(null)", e);
      }

      var projected:Vector3D = Utils3D.projectVector(m, new Vector3D(1, 2, 3));
      trace("projectVector", projected, projected.w);
      var dense:Matrix3D = new Matrix3D(Vector.<Number>([100, 200, 300, 400, 500, 600, 700, 800,
        900, 1000, 1100, 1200, 1300, 1400, 1500, 1600]));
      projected = Utils3D.projectVector(dense, new Vector3D(1, 2, 3, 4));
      trace("projectVector dense", projected, projected.w);
      var verts:Vector.<Number> = new Vector.<Number>();
      var uvts:Vector.<Number> = Vector.<Number>([0, 0, 0, 0, 0, 0]);
      var p:PerspectiveProjection = new PerspectiveProjection();
      Utils3D.projectVectors(p.toMatrix3D(), Vector.<Number>([10, 20, 30, 40, 50, 60]), verts, uvts);
      trace("projectVectors", verts, uvts);
    }
  }
}
