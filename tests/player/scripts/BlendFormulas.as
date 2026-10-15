package {
  import flash.display.*;
  import flash.geom.*;
  import flash.filters.*;

  // Each blend mode's formula, over opaque grounds of five levels: a 6-pixel
  // square in five colours at five alphas a cell, a band a mode, unfiltered
  // on the left and through a filter that leaves its pixels as they are on
  // the right. Add, subtract, multiply and screen are the GPU's own blends
  // there, lighten, darken and difference not (render/view.ts, directBlend).
  public class BlendFormulas extends Sprite {
    public function BlendFormulas() {
      var modes:Array = ["add", "screen", "multiply", "lighten", "darken", "subtract", "difference"];
      var backs:Array = [0x00, 0x40, 0x80, 0xc0, 0xff];
      var cols:Array = [0x00, 0x33, 0x80, 0xcc, 0xff];
      var alphas:Array = [1, 0.75, 0.5, 0.25, 0.1];
      for (var m:int = 0; m < modes.length; m++) {
        for (var f:int = 0; f < 2; f++) {
          for (var bi:int = 0; bi < 5; bi++) {
            for (var ci:int = 0; ci < 5; ci++) {
              for (var ai:int = 0; ai < 5; ai++) {
                var x:Number = (ci * 5 + ai) * 6 + f * 160;
                var y:Number = (m * 5 + bi) * 6;
                var b:uint = backs[bi];
                graphics.beginFill((b << 16) | ((255 - b) << 8) | 0x40);
                graphics.drawRect(x, y, 6, 6);
                graphics.endFill();
                var c:uint = cols[ci];
                var s:Shape = new Shape();
                s.graphics.beginFill((c << 16) | ((255 - c) << 8) | 0x80, alphas[ai]);
                s.graphics.drawRect(0, 0, 6, 6);
                s.graphics.endFill();
                s.x = x;
                s.y = y;
                s.blendMode = modes[m];
                if (f == 1) {
                  // A shadow far away: the object's own pixels pass through the filter.
                  s.filters = [new DropShadowFilter(100, 45, 0, 0, 2, 2)];
                }
                addChild(s);
              }
            }
          }
        }
      }
      trace("drawn");
    }
  }
}
