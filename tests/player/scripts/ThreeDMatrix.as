package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.geom.Matrix3D;
  import flash.geom.Vector3D;

  // A 3D object's transform.matrix3D is its own Matrix3D, live: the getter
  // gives the same one each time, changing it moves the object and its
  // properties are read from it again, setting a property changes it, and
  // the setter takes the one given as the object's own, a clone of equal
  // values too, refusing one that is another object's.
  public class ThreeDMatrix extends Sprite {
    private function box(x:Number, y:Number):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(0xcc3333);
      s.graphics.drawRect(-20, -20, 40, 40);
      s.graphics.endFill();
      s.x = x;
      s.y = y;
      addChild(s);
      return s;
    }

    public function ThreeDMatrix() {
      var s:Sprite = box(50, 50);
      s.z = 0;
      var m1:Matrix3D = s.transform.matrix3D;
      trace("same", m1 == s.transform.matrix3D);
      m1.appendTranslation(50, 0, 0);
      trace("moved", s.x, s.z, s.transform.matrix3D.position);
      m1.appendRotation(30, Vector3D.Y_AXIS);
      trace("turned", s.rotationY, s.x, s.z);
      s.rotationY = 10;
      trace("set", m1.rawData, m1 == s.transform.matrix3D);
      s.x = 120;
      trace("x set", m1.position);
      var n:Matrix3D = new Matrix3D();
      n.appendTranslation(30, 40, 0);
      s.transform.matrix3D = n;
      trace("kept", s.transform.matrix3D == n, m1 == s.transform.matrix3D);
      n.appendTranslation(1, 0, 0);
      m1.appendTranslation(0, 100, 0);
      trace("given", s.x, s.y, s.transform.matrix3D.position);
      s.x = 100;
      trace("x set", n.position);

      var a:Sprite = box(150, 150);
      var b:Sprite = box(250, 150);
      var shared:Matrix3D = new Matrix3D();
      shared.appendTranslation(200, 150, 0);
      a.transform.matrix3D = shared;
      try {
        b.transform.matrix3D = shared;
      } catch (e:Error) {
        trace("another's", e.errorID, b.transform.matrix3D);
      }
      var a2:Sprite = box(150, 150);
      a2.z = 0;
      try {
        b.transform.matrix3D = a2.transform.matrix3D;
      } catch (e:Error) {
        trace("another's", e.errorID);
      }
      a.transform.matrix3D = null;
      b.transform.matrix3D = shared;
      trace("let go", b.transform.matrix3D == shared);
      shared.appendTranslation(0, 50, 0);
      trace("moved", a.y, b.y);

      var c:Sprite = box(350, 50);
      c.rotationY = 10;
      var copy:Matrix3D = c.transform.matrix3D.clone();
      c.transform.matrix3D = copy;
      trace("clone", c.rotationY, c.transform.matrix3D == copy);
      var held:Matrix3D = c.transform.matrix3D;
      c.transform.matrix3D = null;
      held.appendTranslation(10, 0, 0);
      trace("2D", c.x, c.transform.matrix3D, held.position);

      // The rotation setters' sines and cosines, of float32 radians.
      for each (var d:Number in [40, 25, 77.7, -123.4, 370, 1000.5]) {
        var t:Shape = new Shape();
        addChild(t);
        t.rotationY = d;
        var u:Shape = new Shape();
        addChild(u);
        u.rotationX = d;
        u.rotationZ = d / 3;
        trace(d, t.transform.matrix3D.rawData.slice(0, 3), u.transform.matrix3D.rawData.slice(0, 11));
      }

      // Infinite scales: their columns infinite where the rotation's is 1, NaN elsewhere, and an
      // object with a NaN in its matrix not drawn.
      var w:Sprite = box(300, 300);
      w.z = 0;
      w.scaleX = Infinity;
      trace("infinite", w.transform.matrix3D.rawData, w.scaleX);
      w.scaleY = -Infinity;
      trace("infinite", w.transform.matrix3D.rawData, w.scaleY);
      var v:Sprite = box(400, 300);
      v.z = 0;
      v.scaleZ = Infinity;
      trace("infinite", v.transform.matrix3D.rawData, v.scaleZ);
    }
  }
}
