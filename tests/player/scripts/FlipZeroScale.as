package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.geom.Matrix;
  import flash.geom.Matrix3D;
  import flash.geom.Rectangle;
  import flash.geom.Vector3D;

  // A card flip: a scale through 0 and a 3D property set after it. Flash
  // keeps a 3D scale no nearer 0 than 1.175494351e-36, so the matrix
  // stays invertible and the scale comes back; a 2D matrix with a column
  // of no length cannot be taken apart into 3D, and the first 3D scale or
  // rotation set then makes the object the identity, losing what was set.
  // Its position after that is whatever Flash's memory held (a 1e-35 or a
  // 1e17), so it is set before anything reads it. Values Flash's 16.16
  // 2D matrix makes noisy are left out, and so are bounds in 3D, which
  // Flash gives in a mix of pixels and twips.
  public class FlipZeroScale extends Sprite {
    public function FlipZeroScale() {
      // A 2D flip, from 1 to -1 through 0: the other column and the bounds follow.
      var flat:Shape = box(10);
      for (var i:int = 0; i <= 4; i++) {
        flat.scaleX = 1 - i * 0.5;
        step("2D tween", flat, true);
      }

      flat.scaleX = 0;
      flat.scaleY = 0;
      flat.scaleX = -1;
      flat.scaleY = 1;
      step("2D both through 0", flat, true);
      trace("2D rotationZ", flat.rotationZ);

      // The same in 3D: the scale is kept at the least, not 0, and comes back.
      var deep:Shape = box(50);
      deep.rotationY = 0;
      for each (var v:Number in [1, 0.5, 0, -0.5, -1, 0, 1]) {
        deep.scaleX = v;
        step("3D tween", deep, false);
      }

      deep.scaleX = 0;
      deep.rotationY = 45;
      step("3D rotationY after 0", deep, false);
      deep.scaleX = 1;
      deep.rotationY = 0;
      step("3D back", deep, false);

      var least:Shape = box(0);
      least.z = 0;
      for each (v in [0, -0, 1e-40, -1e-37, 1.17e-36, 1.18e-36, -1.18e-36, 1e-30, NaN]) {
        least.scaleX = v;
        least.scaleY = v;
        least.scaleZ = v;
        trace("least", v, least.scaleX, least.scaleY, least.scaleZ,
          least.transform.matrix3D.rawData[0]);
      }

      trace("determinant", least.transform.matrix3D.determinant);
      // Its own matrix3D set back changes nothing, though its determinant is 0 in float32.
      least.transform.matrix3D = least.transform.matrix3D;
      trace("set back", least.scaleX);
      var scaled:Shape = box(0);
      scaled.scaleZ = 0.1;
      trace("scaleZ entering 3D", scaled.scaleZ);
      scaled.scaleZ = 0.1;
      trace("scaleZ in 3D", scaled.scaleZ);

      // A 2D scale of 0 and then a 3D rotation or scale: the identity, the rotation lost.
      var lost:Shape = box(90);
      lost.scaleX = 0;
      lost.rotationY = 45;
      linear("scaleX 0, rotationY", lost);
      lost.x = 90;
      lost.y = 5;
      lost.z = 0;
      step("moved back", lost, false);
      lost.rotationY = 30;
      step("rotationY again", lost, false);
      lost.rotationY = 0;

      var rows:Shape = box(0);
      rows.scaleY = 0;
      rows.rotationX = 30;
      linear("scaleY 0, rotationX", rows);
      rows = box(0);
      rows.scaleX = 0;
      rows.scaleZ = 3;
      linear("scaleX 0, scaleZ", rows);
      rows = box(0);
      rows.scaleX = 0;
      rows.scaleY = 0;
      rows.rotationY = 5;
      linear("both 0, rotationY", rows);
      rows = box(0);
      rows.scaleX = -1;
      rows.rotationY = 5;
      step("scaleX -1, rotationY", rows, false);

      // A position goes in, and reads back, until a scale or rotation is set.
      var moved:Shape = box(0);
      moved.scaleX = 0;
      moved.z = 5;
      moved.z = 7;
      moved.y = 9;
      step("scaleX 0, z", moved, false);
      moved.scaleX = 1;
      linear("then scaleX", moved);
      moved = box(0);
      moved.scaleX = 0;
      moved.transform.matrix = null;
      step("scaleX 0, matrix null", moved, false);

      // matrix3D: read in 2D it is null, set to null changes nothing; one of float32 determinant 0 is refused.
      var read:Shape = box(130);
      read.scaleX = 0;
      trace("matrix3D in 2D", read.transform.matrix3D);
      read.transform.matrix3D = null;
      step("matrix3D null in 2D", read, true);
      refuse(read, [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1]);
      refuse(read, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
      refuse(read, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
      refuse(read, [1e-30, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1e-30, 0, 0, 0, 0, 1]);
      refuse(read, [1e-6, 0, 0, 0, 0, 1e-6, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      step("after", read, false);
      read.transform.matrix = new Matrix(1, 0, 0, 1, 130, 5);
      step("2D again", read, true);

      // matrix3D null gives back the 2D scales from before 3D, at the identity.
      var back:Shape = box(0);
      back.scaleX = 2;
      back.scaleY = 3;
      back.rotationY = 30;
      back.scaleX = 0;
      back.transform.matrix3D = null;
      step("matrix3D null", back, true);

      // Under a 3D parent, on the list but not drawn.
      var parent:Sprite = new Sprite();
      parent.rotationY = 30;
      parent.visible = false;
      addChild(parent);
      var child:Shape = box(0);
      parent.addChild(child);
      child.scaleX = 0;
      child.rotationY = 45;
      linear("nested", child);
      linear("nested, to the root", child, child.transform.getRelativeMatrix3D(this));

      addChild(flat);
      addChild(deep);
      addChild(lost);
      addChild(read);
    }

    private function box(x:Number):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(0xff0000);
      s.graphics.drawRect(0, 0, 20, 10);
      s.x = x;
      s.y = 5;
      return s;
    }

    private function r(n:Number):Number {
      return Math.round(n * 10000) / 10000;
    }

    private function raw(m:Matrix3D, length:int = 16):String {
      if (!m) {
        return "null";
      }

      var out:Array = [];
      for (var i:int = 0; i < length; i++) {
        out.push(r(m.rawData[i]));
      }

      return out.join(",");
    }

    private function step(label:String, s:Shape, bounds:Boolean):void {
      trace(label, "|", s.x, s.y, s.z, r(s.scaleX), r(s.scaleY), r(s.scaleZ), r(s.rotation),
        r(s.rotationX), r(s.rotationY), r(s.rotationZ));
      trace("  ", s.transform.matrix, raw(s.transform.matrix3D));
      if (bounds) {
        var b:Rectangle = s.getBounds(this);
        trace("  ", b, s.width, s.height);
      }
    }

    /** Its scales, rotations and matrix3D but for the position, which Flash leaves as its memory had it. */
    private function linear(label:String, s:Shape, m:Matrix3D = null):void {
      trace(label, "|", r(s.scaleX), r(s.scaleY), r(s.scaleZ), r(s.rotation), r(s.rotationX),
        r(s.rotationY), r(s.rotationZ));
      trace("  ", raw(m || s.transform.matrix3D, 12));
    }

    private function refuse(s:Shape, values:Array):void {
      try {
        s.transform.matrix3D = new Matrix3D(Vector.<Number>(values));
        trace("taken", raw(s.transform.matrix3D));
      } catch (e:Error) {
        trace("refused", e.errorID);
      }
    }
  }
}
