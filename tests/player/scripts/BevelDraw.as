package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;

  // Bevels drawn as adl draws them: on shapes, at the default 45° and
  // between the axes, inner, outer and full, knocked out, of a
  // half-transparent shape; and applyFilter's at those angles, shown as
  // Bitmaps.
  public class BevelDraw extends Sprite {
    private function ground(k:int):Point {
      var x:Number = (k % 6) * 66;
      var y:Number = int(k / 6) * 66;
      graphics.beginFill(0x808080);
      graphics.drawRect(x, y, 64, 64);
      graphics.endFill();
      return new Point(x, y);
    }

    private function shape(k:int, f:BevelFilter, alpha:Number = 1):void {
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

    private function bitmap(k:int, f:BevelFilter):void {
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

    public function BevelDraw() {
      shape(0, new BevelFilter());
      shape(1, new BevelFilter(4, 30, 0xffffff, 1, 0, 1, 6, 6, 2, 2));
      shape(2, new BevelFilter(3, 0, 0xffff00, 1, 0xff00ff, 1, 4, 4, 1, 1, "outer"));
      shape(3, new BevelFilter(3, 135, 0xffffff, 1, 0x000080, 1, 4, 4, 1, 1, "full"));
      shape(4, new BevelFilter(4, 45, 0xffffff, 1, 0, 1, 4, 4, 1, 1, "inner", true));
      shape(5, new BevelFilter(4, 45, 0xffffff, 1, 0, 1, 4, 4, 1, 1, "outer", true));
      shape(6, new BevelFilter(4, 45, 0xffffff, 1, 0, 1, 4, 4, 1, 1, "full", true));
      shape(7, new BevelFilter(), 0.5);
      shape(8, new BevelFilter(6, 225, 0xff8000, 0.6, 0x0080ff, 0.8, 8, 3, 3, 1));
      shape(9, new BevelFilter(2, 90, 0xffffff, 1, 0, 1, 0, 0, 1, 1));
      shape(10, new BevelFilter(5, 300, 0xffffff, 1, 0, 1, 10, 10, 1, 3, "full"));
      shape(11, new BevelFilter(4, 45, 0xffffff, 1, 0, 1, 3, 3, 3, 1));
      bitmap(12, new BevelFilter());
      bitmap(13, new BevelFilter(4, 30, 0xffffff, 1, 0, 1, 6, 6, 2, 2));
      bitmap(14, new BevelFilter(3, 135, 0xffffff, 1, 0x000080, 1, 4, 4, 1, 1, "full"));
      bitmap(15, new BevelFilter(4, 45, 0xffffff, 1, 0, 1, 4, 4, 1, 1, "outer", true));
      trace("drawn");
    }
  }
}
