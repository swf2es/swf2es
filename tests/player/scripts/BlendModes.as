package {
  import flash.display.*;
  import flash.geom.*;

  // Each blend mode over a grey and a blue ground, of a sprite of two
  // overlapping squares, orange and green at 0.6, which adl composites as
  // a layer before it blends it; alpha and erase in a layer of their own.
  public class BlendModes extends Sprite {
    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    public function BlendModes() {
      // Rows 1 and 2: each blend mode over a grey and a blue ground, of a sprite of
      // two overlapping squares: orange, and green at 0.6.
      var modes:Array = ["normal", "layer", "multiply", "screen", "lighten", "darken", "difference",
        "add", "subtract", "invert", "alpha", "erase", "overlay", "hardlight"];
      for (var k:int = 0; k < modes.length; k++) {
        var x:Number = (k % 7) * 100;
        var y:Number = int(k / 7) * 100;
        var ground:Sprite = new Sprite();
        rect(ground.graphics, 0x808080, 1, x, y, 100, 50);
        rect(ground.graphics, 0x3366cc, 0.8, x, y + 50, 100, 50);
        addChild(ground);
        var s:Sprite = new Sprite();
        rect(s.graphics, 0xff8800, 1, x + 10, y + 10, 50, 70);
        var t:Shape = new Shape();
        rect(t.graphics, 0x00cc88, 0.6, x + 40, y + 25, 50, 70);
        s.addChild(t);
        s.blendMode = modes[k];
        // alpha and erase work on the layer they are in: give each its own.
        var holder:Sprite = new Sprite();
        if (modes[k] == "alpha" || modes[k] == "erase") {
          holder.blendMode = "layer";
          holder.addChild(ground);
        }
        holder.addChild(s);
        addChild(holder);
      }
      trace("drawn");
    }
  }
}
