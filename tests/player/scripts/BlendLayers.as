package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.ColorTransform;

  // Blended sprites of overlapping, partly clear parts over a ground, on whole pixels: each is one
  // layer in Flash, its parts first drawn over each other, then the whole blended. A moves on the
  // second frame while a part moves within C; a part of B changes on the third. A adds, B screens,
  // C multiplies.
  public class BlendLayers extends Sprite {
    private function part(s:Sprite, color:uint, alpha:Number, x:Number, y:Number):Shape {
      var p:Shape = new Shape();
      p.graphics.beginFill(color, alpha);
      p.graphics.drawRect(x - 20, y - 15, 40, 30);
      p.graphics.endFill();
      s.addChild(p);
      return p;
    }

    private function layer(mode:String, x:Number):Sprite {
      var s:Sprite = new Sprite();
      part(s, 0xc04020, 0.7, 20, 25);
      part(s, 0x20a0c0, 0.5, 40, 35);
      part(s, 0x60c020, 0.6, 28, 50);
      s.blendMode = mode;
      s.x = x;
      s.y = 10;
      addChild(s);
      return s;
    }

    public function BlendLayers() {
      graphics.beginFill(0x405060);
      graphics.drawRect(0, 0, 240, 100);
      graphics.beginFill(0xa08040);
      graphics.drawRect(0, 50, 240, 50);
      graphics.endFill();

      var a:Sprite = layer("add", 5);
      var b:Sprite = layer("screen", 85);
      var c:Sprite = layer("multiply", 165);
      var changed:Shape = Shape(b.getChildAt(1));
      var moved:Shape = Shape(c.getChildAt(1));

      var frame:int = 0;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        frame++;
        if (frame == 1) {
          a.x += 10;
          moved.y += 6;
        } else if (frame == 2) {
          changed.transform.colorTransform = new ColorTransform(0, 1, 0.5, 1, 0, 40, 0, 0);
        }
      });
      trace("drawn");
    }
  }
}
