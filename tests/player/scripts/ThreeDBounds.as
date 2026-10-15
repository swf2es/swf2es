package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.filters.GlowFilter;
  import flash.geom.Point;
  import flash.geom.Rectangle;

  // Bounds and concatenated matrices of 3D objects and what is in them, read
  // once they have been drawn: before, adl's are not yet made. A 3D object's
  // box in its parent is the box on the stage, out to whole pixels but for
  // an eighth, taken back into the parent's space: a box of a box under a
  // turned parent; in a 3D parent, its width is through its flat matrix.
  // Its concatenatedMatrix is null, and that of a 2D object in it is in the
  // space of the bitmap it is drawn into.
  public class ThreeDBounds extends Sprite {
    private var frames:int = 0;

    private function card(parent:Sprite, x:Number, y:Number, w:Number, h:Number):Sprite {
      var c:Sprite = new Sprite();
      c.graphics.beginFill(0xff0000);
      c.graphics.drawRect(-w / 2, -h / 3, w, h);
      c.x = x;
      c.y = y;
      parent.addChild(c);
      return c;
    }

    private function kid(parent:Sprite, x:Number, y:Number, scale:Number = 1):Sprite {
      var k:Sprite = new Sprite();
      k.graphics.beginFill(0x00ff00);
      k.graphics.drawRect(0, 0, 10, 10);
      k.x = x;
      k.y = y;
      k.scaleX = k.scaleY = scale;
      parent.addChild(k);
      return k;
    }

    public function ThreeDBounds() {
      var c1:Sprite = card(this, 100, 100, 40, 60);
      c1.rotationY = 30;
      var k1:Sprite = kid(c1, 5, 0);
      var g1:Sprite = kid(k1, 3, 4, 2);
      var c2:Sprite = card(this, 250, 100, 37.5, 61.3);
      c2.scaleX = 2;
      c2.rotationX = 20;
      var k2:Sprite = kid(c2, 5.5, 5, 0.5);
      var c3:Sprite = card(this, 400, 100, 40, 60);
      c3.filters = [new GlowFilter(0xffff00, 1, 10, 10)];
      c3.z = 50;
      var k3:Sprite = kid(c3, 5, 0);
      var c4:Sprite = card(this, 100, 300, 40, 60);
      c4.graphics.lineStyle(4, 0);
      c4.graphics.drawRect(-30, -30, 70, 70);
      c4.rotationY = -20;
      var k4:Sprite = kid(c4, 5, 0);
      var p5:Sprite = new Sprite();
      p5.x = 250;
      p5.y = 300;
      p5.rotation = 30;
      addChild(p5);
      var c5:Sprite = card(p5, 20, 10, 40, 60);
      c5.rotationX = 30;
      var n5:Sprite = card(c5, 10, 10, 20, 20);
      n5.rotationY = 30;
      var k5:Sprite = kid(n5, 1, 2);
      var p6:Sprite = new Sprite();
      p6.x = 400;
      p6.y = 300;
      p6.rotation = -45;
      p6.scaleX = 0.5;
      addChild(p6);
      var c6:Sprite = card(p6, 0, 0, 50, 50);
      c6.rotationY = 25;
      var matrices:Array = [c1, k1, g1, c2, k2, c3, k3, c4, k4, c5, n5, k5, c6];
      var boxes:Array = [c1, c2, c3, c4, n5];
      addEventListener(Event.ENTER_FRAME, function (e:Event):void {
        frames++;
        if (frames == 2) {
          var i:int;
          for (i = 0; i < matrices.length; i++) {
            trace(i, matrices[i].transform.concatenatedMatrix);
          }

          for (i = 0; i < boxes.length; i++) {
            trace(i, boxes[i].getBounds(boxes[i].parent), boxes[i].getBounds(stage), boxes[i].width, boxes[i].height);
          }

          // Under turned parents, the box of a box: its corner differs from adl's by a twip, adl
          // cutting toward zero where it rounds a 2D object's, its size not.
          var r:Rectangle = c6.getBounds(p6);
          trace(c6.getBounds(stage), c6.width, c6.height, r.width, r.height);
          trace(c5.getBounds(stage), p5.getBounds(stage).x, p5.getBounds(stage).y);
          trace(c1.globalToLocal(new Point(100, 100)), c1.globalToLocal(new Point(110, 120)), k1.globalToLocal(new Point(100, 100)));
          trace(c2.globalToLocal(new Point(250, 100)), c3.globalToLocal(new Point(400, 100)), n5.globalToLocal(new Point(260, 320)));
          trace(c1.localToGlobal(new Point(10, 10)), c5.localToGlobal(new Point(0, 0)), k5.localToGlobal(new Point(0, 0)));
        }
      });
    }
  }
}
