package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;

  // Gradient glows and bevels drawn as adl draws them: on shapes, along
  // the axes and between, inner, outer and full, knocked out, of a
  // half-transparent shape; and applyFilter's, shown as Bitmaps.
  public class GradientDraw extends Sprite {
    private function ground(k:int):Point {
      var x:Number = (k % 6) * 66;
      var y:Number = int(k / 6) * 66;
      graphics.beginFill(0x808080);
      graphics.drawRect(x, y, 64, 64);
      graphics.endFill();
      return new Point(x, y);
    }

    private function shape(k:int, f:BitmapFilter, alpha:Number = 1):void {
      var p:Point = ground(k);
      var s:Shape = new Shape();
      s.graphics.beginFill(0x00aa00, alpha);
      s.graphics.drawRect(0, 0, 24, 24);
      s.graphics.endFill();
      s.graphics.beginFill(0xffcc00, alpha);
      s.graphics.drawRect(7, 7, 10, 10);
      s.graphics.endFill();
      s.x = p.x + 20;
      s.y = p.y + 20;
      s.filters = [f];
      addChild(s);
    }

    private function bitmap(k:int, f:BitmapFilter):void {
      var p:Point = ground(k);
      var src:BitmapData = new BitmapData(44, 44, true, 0);
      src.fillRect(new Rectangle(10, 10, 24, 24), 0xff00aa00);
      var dst:BitmapData = new BitmapData(44, 44, true, 0);
      dst.applyFilter(src, src.rect, new Point(0, 0), f);
      var b:Bitmap = new Bitmap(dst);
      b.x = p.x + 10;
      b.y = p.y + 10;
      addChild(b);
    }

    public function GradientDraw() {
      var rgb:Array = [0xff0000, 0x00ff00, 0x0000ff];
      var fade:Array = [0xffff00, 0xff0000];
      var ones:Array = [1, 1, 1];
      var spread:Array = [0, 128, 255];
      shape(0, new GradientGlowFilter(0, 0, [0xffffff, 0xff0000], [0, 1], [0, 255], 8, 8, 1, 1, "outer"));
      shape(1, new GradientGlowFilter(4, 45, rgb, ones, spread, 6, 6, 1, 1, "outer"));
      shape(2, new GradientGlowFilter(0, 0, fade, [1, 0.5], [0, 255], 6, 6, 2, 2, "inner"));
      shape(3, new GradientGlowFilter(3, 90, [0xffffff, 0x0000ff], [0, 1], [0, 255], 10, 4, 1, 1, "full"));
      shape(4, new GradientGlowFilter(0, 0, [0xffffff, 0xff00ff], [0, 1], [0, 255], 8, 8, 1, 1, "outer", true));
      shape(5, new GradientGlowFilter(0, 0, [0xffffff, 0xff00ff], [0, 1], [0, 255], 8, 8, 1, 1, "outer"), 0.5);
      shape(6, new GradientBevelFilter());
      shape(7, new GradientBevelFilter(4, 0, [0xffffff, 0xffffff, 0], [1, 0, 1], spread, 4, 4, 1, 1, "inner"));
      shape(8, new GradientBevelFilter(4, 45, [0xffffff, 0xff0000, 0], [1, 0, 1], spread, 4, 4, 1, 1, "full"));
      shape(9, new GradientBevelFilter(3, 90, rgb, ones, spread, 3, 3, 2, 1, "outer"));
      shape(10, new GradientBevelFilter(4, 135, [0xffffff, 0x808080, 0], [1, 0, 1], spread, 6, 6, 1, 2, "inner", true));
      shape(11, new GradientBevelFilter(3, 0, [0xffffff, 0x808080, 0], [1, 0, 1], spread, 4, 4, 1, 1), 0.5);
      bitmap(12, new GradientGlowFilter(4, 45, rgb, ones, spread, 6, 6, 1, 1, "outer"));
      bitmap(13, new GradientGlowFilter(0, 0, fade, [1, 0.5], [0, 255], 6, 6, 2, 2, "inner"));
      bitmap(14, new GradientBevelFilter(4, 45, [0xffffff, 0xff0000, 0], [1, 0, 1], spread, 4, 4, 1, 1, "full"));
      bitmap(15, new GradientBevelFilter(4, 135, [0xffffff, 0x808080, 0], [1, 0, 1], spread, 6, 6, 1, 2, "inner", true));
      trace("drawn");
    }
  }
}
