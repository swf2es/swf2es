package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;

  // Displacement maps drawn on display objects as adl draws them: by a
  // flat map, a ramp, a map smaller than the object and placed, in each
  // mode, of a half-transparent object; and applyFilter's, as Bitmaps.
  public class DisplacementDraw extends Sprite {
    private function ground(k:int):Point {
      var x:Number = (k % 6) * 66;
      var y:Number = int(k / 6) * 66;
      graphics.beginFill(0x808080);
      graphics.drawRect(x, y, 64, 64);
      graphics.endFill();
      return new Point(x, y);
    }

    private function art(s:Shape, alpha:Number):void {
      for (var i:int = 0; i < 4; i++) {
        s.graphics.beginFill([0x00aa00, 0xffcc00, 0xcc3300, 0x0033cc][i], alpha);
        s.graphics.drawRect((i % 2) * 12, int(i / 2) * 12, 12, 12);
        s.graphics.endFill();
      }
    }

    private function shape(k:int, f:DisplacementMapFilter, alpha:Number = 1):void {
      var p:Point = ground(k);
      var s:Shape = new Shape();
      art(s, alpha);
      s.x = p.x + 20;
      s.y = p.y + 20;
      s.filters = [f];
      addChild(s);
    }

    private function bitmap(k:int, f:DisplacementMapFilter):void {
      var p:Point = ground(k);
      var s:Shape = new Shape();
      art(s, 1);
      var src:BitmapData = new BitmapData(24, 24, true, 0);
      src.draw(s);
      var dst:BitmapData = new BitmapData(24, 24, true, 0);
      dst.applyFilter(src, src.rect, new Point(0, 0), f);
      var b:Bitmap = new Bitmap(dst);
      b.x = p.x + 20;
      b.y = p.y + 20;
      addChild(b);
    }

    public function DisplacementDraw() {
      var flat:BitmapData = new BitmapData(25, 25, true, 0xffa0c080);
      var ramp:BitmapData = new BitmapData(25, 25, true, 0);
      for (var y:int = 0; y < 25; y++) for (var x:int = 0; x < 25; x++) ramp.setPixel32(x, y, 0xff000080 | ((x * 10) & 0xff) << 16 | ((y * 10) & 0xff) << 8);
      var small:BitmapData = new BitmapData(10, 8, true, 0xffe0e080);
      shape(0, new DisplacementMapFilter(flat, new Point(0, 0), 1, 2, 8, 8));
      shape(1, new DisplacementMapFilter(ramp, new Point(0, 0), 1, 2, 10, 10));
      shape(2, new DisplacementMapFilter(small, new Point(6, 8), 1, 2, 20, 20));
      shape(3, new DisplacementMapFilter(ramp, new Point(0, 0), 1, 2, 30, 30, "clamp"));
      shape(4, new DisplacementMapFilter(ramp, new Point(0, 0), 1, 2, 30, 30, "ignore"));
      shape(5, new DisplacementMapFilter(ramp, new Point(0, 0), 1, 2, 30, 30, "color", 0xff00ff, 0.5));
      shape(6, new DisplacementMapFilter(flat, new Point(0, 0), 1, 2, 5.5, -7.5), 0.5);
      shape(7, new DisplacementMapFilter(ramp, new Point(3, 2), 4, 2, 12, 12));
      shape(8, new DisplacementMapFilter(null, new Point(0, 0), 1, 2, 8, 8));
      bitmap(12, new DisplacementMapFilter(ramp, new Point(0, 0), 1, 2, 10, 10));
      bitmap(13, new DisplacementMapFilter(ramp, new Point(0, 0), 1, 2, 30, 30, "ignore"));
      bitmap(14, new DisplacementMapFilter(flat, new Point(0, 0), 1, 2, 5.5, -7.5));
      trace("drawn");
    }
  }
}
