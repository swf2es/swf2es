package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.geom.Matrix;
  import flash.geom.Matrix3D;
  import flash.geom.Vector3D;

  // A display object's own Matrix3D (transform.matrix3D) after the object
  // leaves 3D and comes back, set on another object (2189), adopted, and
  // changed by each of Matrix3D's members: most move the object and have
  // its properties read again; copyToMatrix3D, copyRowFrom and
  // copyColumnFrom change the matrix alone. Then its properties written
  // through, transform.matrix on it, one off the list, one replaced, one
  // copied with DisplayObject.transform, and its own set back.
  public class ThreeDMatrixShared extends Sprite {
    public function ThreeDMatrixShared() {
      var a:Sprite = card();
      var b:Sprite = card();
      a.z = 0;
      var m:Matrix3D = a.transform.matrix3D;
      t("same getter", m == a.transform.matrix3D, a.transform.matrix3D == a.transform.matrix3D);
      // 1. going 2D through matrix3D = null
      a.transform.matrix3D = null;
      m.appendTranslation(10, 0, 0);
      t("after null", a.x, a.transform.matrix3D, m.rawData[12]);
      a.z = 1;
      t("back 3D", a.transform.matrix3D == m, a.transform.matrix3D.rawData[12], a.x);
      m.appendTranslation(5, 0, 0);
      t("old after back", a.x);
      // 2. shared
      var ma:Matrix3D = a.transform.matrix3D;
      try {
        b.transform.matrix3D = ma;
        t("shared ok", b.transform.matrix3D == ma, a.transform.matrix3D == ma);
        ma.appendTranslation(3, 0, 0);
        t("shared moved", a.x, b.x);
      } catch (e:Error) {
        t("shared", e.errorID);
      }
      // 3. adopt a fresh one
      var n:Matrix3D = new Matrix3D();
      b.transform.matrix3D = n;
      n.appendTranslation(7, 8, 9);
      t("adopted", b.x, b.y, b.z, b.transform.matrix3D == n);
      // 4. each method
      n.identity(); t("identity", b.x, b.z);
      n.appendRotation(30, Vector3D.Y_AXIS); t("appendRotation", r(b.rotationY));
      n.prependRotation(10, Vector3D.X_AXIS); t("prependRotation", r(b.rotationX), r(b.rotationY));
      n.appendScale(2, 1, 1); t("appendScale", r(b.scaleX));
      n.prependScale(1, 3, 1); t("prependScale", r(b.scaleY));
      n.prependTranslation(1, 2, 3); t("prependTranslation", r(b.x), r(b.y), r(b.z));
      var o:Matrix3D = new Matrix3D();
      o.appendTranslation(20, 30, 40);
      n.copyFrom(o); t("copyFrom", b.x, b.y, b.z, r(b.scaleX));
      o.appendTranslation(1, 1, 1);
      o.copyToMatrix3D(n); t("copyToMatrix3D", b.x, b.y, b.z);
      n.append(o); t("append", b.x);
      n.prepend(o); t("prepend", b.x);
      n.invert(); t("invert", b.x);
      n.transpose(); t("transpose", b.x, r(b.rotationX));
      n.identity();
      n.position = new Vector3D(4, 5, 6); t("position", b.x, b.y, b.z);
      var v:Vector.<Number> = n.rawData;
      v[12] = 50;
      n.rawData = v; t("rawData", b.x);
      v[12] = 60;
      n.copyRawDataFrom(v); t("copyRawDataFrom", b.x);
      n.copyColumnFrom(3, new Vector3D(70, 71, 72, 1)); t("copyColumnFrom", b.x, b.y, b.z);
      n.copyRowFrom(0, new Vector3D(1, 0, 0, 80)); t("copyRowFrom", b.x);
      var comps:Vector.<Vector3D> = n.decompose();
      comps[0].x = 90;
      n.recompose(comps); t("recompose", b.x);
      n.interpolateTo(o, 0.5); t("interpolateTo", r(b.x));
      n.pointAt(new Vector3D(0, 0, 100)); t("pointAt", r(b.x), r(b.rotationX), r(b.rotationY));
      var sx:Number = b.x;
      var c:Matrix3D = Matrix3D.interpolate(n, o, 0.5);
      c.appendTranslation(100, 0, 0); t("static interpolate", b.x == sx);
      var cl:Matrix3D = n.clone();
      cl.appendTranslation(100, 0, 0); t("clone", b.x == sx);
      // 5. singular in place
      n.identity();
      try { n.appendScale(0, 1, 1); t("singular", b.x); t("singular2", b.scaleX, b.rotationY); t("s3", b.transform.matrix3D == n); } catch (e:Error) { t("singular threw", e.errorID); }
      n.identity();
      t("after singular", b.scaleX, b.transform.matrix3D == n);
      // 6. properties write through
      b.rotationY = 30;
      t("property", r(n.rawData[0]), r(n.rawData[8]));
      b.x = 33;
      t("x", n.rawData[12]);
      // 7. transform.matrix on 3D
      t("matrix on 3D", b.transform.matrix);
      b.transform.matrix = new Matrix(1, 0, 0, 1, 5, 5);
      t("matrix set", b.transform.matrix3D, b.x);
      n.appendTranslation(1, 0, 0);
      t("after matrix set", b.x, b.transform.matrix3D);
      b.z = 2;
      t("again", b.transform.matrix3D == n);
      // 8. removed object
      var d:Sprite = card();
      d.z = 1;
      var md:Matrix3D = d.transform.matrix3D;
      removeChild(d);
      md.appendTranslation(11, 0, 0);
      t("removed", d.x);
      // 9. replaced: old getter result after a new one is set
      var e2:Sprite = card();
      e2.z = 1;
      var old:Matrix3D = e2.transform.matrix3D;
      var fresh:Matrix3D = new Matrix3D();
      e2.transform.matrix3D = fresh;
      old.appendTranslation(12, 0, 0);
      t("old after set", e2.x, e2.transform.matrix3D == fresh);
      try {
        a.transform.matrix3D = fresh;
        t("steal fresh", "ok");
      } catch (e:Error) {
        t("steal fresh", e.errorID);
      }
      // 10. DisplayObject.transform = other's
      var f:Sprite = card();
      f.transform = e2.transform;
      t("transform copy", f.transform.matrix3D == fresh, f.z);
      fresh.appendTranslation(1, 0, 0);
      t("transform copy moved", f.x, e2.x);
      // 11. own set back
      var g:Sprite = card();
      g.rotationY = 370;
      var mg:Matrix3D = g.transform.matrix3D;
      g.transform.matrix3D = mg;
      t("own back", g.rotationY);
      g.transform.matrix3D = mg.clone();
      t("clone back", r(g.rotationY));
    }

    private function r(v:Number):Number {
      return Math.round(v * 1000) / 1000;
    }

    private function t(...args):void {
      trace(args.join(" "));
    }

    private function card():Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(0xcc3333);
      s.graphics.drawRect(0, 0, 10, 10);
      addChild(s);
      return s;
    }
  }
}
