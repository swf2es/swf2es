package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;

  // Filters drawn as adl draws them: blurs at two qualities, glows outer,
  // inner and knocked out, shadows, one with its object hidden, and a
  // colour matrix, each on a square over a grey ground.
  public class FiltersDraw extends Sprite {
    private function cell(k:int, filters:Array, color:uint = 0x00aa00, alpha:Number = 1):void {
      var x:Number = (k % 6) * 66;
      var y:Number = int(k / 6) * 66;
      graphics.beginFill(0x808080);
      graphics.drawRect(x, y, 64, 64);
      graphics.endFill();
      var s:Shape = new Shape();
      s.graphics.beginFill(color, alpha);
      s.graphics.drawRect(x + 20, y + 20, 24, 24);
      s.graphics.endFill();
      s.filters = filters;
      addChild(s);
    }

    public function FiltersDraw() {
      cell(0, [new BlurFilter(4, 4, 1)]);
      cell(1, [new BlurFilter(8, 2, 3)]);
      cell(2, [new GlowFilter(0xff0000, 1, 6, 6, 2, 1)]);
      cell(3, [new GlowFilter(0xffff00, 1, 8, 8, 3, 1, true)]);
      cell(4, [new GlowFilter(0xff0000, 1, 6, 6, 2, 1, false, true)]);
      cell(5, [new GlowFilter(0x0000ff, 0.5, 10, 10, 1, 2)]);
      cell(6, [new DropShadowFilter(4, 45, 0, 1, 4, 4, 1, 1)]);
      cell(7, [new DropShadowFilter(6, 0, 0x0000ff, 1, 0, 0, 1, 1)]);
      cell(8, [new DropShadowFilter(5, 90, 0, 0.8, 3, 3, 1, 1, false, false, true)]);
      cell(9, [new DropShadowFilter(4, 135, 0, 1, 4, 4, 1, 1, true)]);
      cell(10, [new ColorMatrixFilter([0.5, 0, 0, 0, 100, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0])]);
      cell(11, [new BlurFilter(3, 3, 1), new GlowFilter(0xff00ff, 1, 4, 4, 2, 1)], 0x00aa00, 0.6);
      trace("drawn");
    }
  }
}
