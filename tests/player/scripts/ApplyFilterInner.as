package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;

  // Where BitmapData.applyFilter writes for the filters drawn within what
  // they filter (an inner glow, shadow, bevel or gradient filter), against
  // adl: each into a destination filled with a marker, from a rect inside
  // the source's square, past its edge and past the bitmap's, traced as
  // the bounds of what changed and its pixels, with generateFilterRect.
  // Offsets keep to the axes, where adl's reads between pixels are known.
  public class ApplyFilterInner extends Sprite {
    private static const MARK:uint = 0xff0000ff;

    private function probe(label:String, filter:BitmapFilter, rect:Rectangle, at:Point):void {
      var src:BitmapData = new BitmapData(24, 24, true, 0);
      src.fillRect(new Rectangle(6, 6, 12, 12), 0xff20c040);
      src.fillRect(new Rectangle(9, 9, 3, 3), 0x80804020);
      var dst:BitmapData = new BitmapData(40, 40, true, MARK);
      dst.applyFilter(src, rect, at, filter);
      var minX:int = 40, minY:int = 40, maxX:int = -1, maxY:int = -1;
      for (var y:int = 0; y < 40; y++) {
        for (var x:int = 0; x < 40; x++) {
          if (dst.getPixel32(x, y) != MARK) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }
      trace(label, "rect", rect, "at", at, "filterRect", src.generateFilterRect(rect, filter),
        "changed", maxX < 0 ? "none" : minX + "," + minY + " to " + maxX + "," + maxY);
      for (y = minY; y <= maxY; y++) {
        var row:Array = [];
        for (x = minX; x <= maxX; x++) {
          var p:uint = dst.getPixel32(x, y);
          row.push(p == MARK ? "." : p == 0 ? "0" : p.toString(16));
        }
        trace(" " + row.join(" "));
      }
    }

    public function ApplyFilterInner() {
      var filters:Array = [
        ["glow inner", new GlowFilter(0xff0000, 1, 4, 4, 2, 1, true)],
        ["glow inner knockout", new GlowFilter(0xff0000, 1, 4, 4, 2, 1, true, true)],
        ["shadow inner", new DropShadowFilter(3, 0, 0x0000ff, 1, 2, 2, 1, 1, true)],
        ["shadow inner 180", new DropShadowFilter(3, 180, 0x0000ff, 1, 2, 2, 1, 1, true)],
        ["shadow inner knockout", new DropShadowFilter(3, 90, 0x0000ff, 1, 2, 2, 1, 1, true, true)],
        ["bevel inner", new BevelFilter(2, 0, 0xffffff, 1, 0x000000, 1, 2, 2, 1, 1, "inner")],
        ["gradient glow inner", new GradientGlowFilter(2, 270, [0xff0000, 0x00ff00], [0, 1], [0, 255], 2, 2, 1, 1, "inner")],
        ["gradient bevel inner", new GradientBevelFilter(2, 90, [0xffffff, 0x808080, 0], [1, 0, 1], [0, 128, 255], 2, 2, 1, 1, "inner")],
        ["glow outer", new GlowFilter(0xff0000, 1, 4, 4, 2, 1)],
      ];
      var rects:Array = [
        [new Rectangle(8, 8, 8, 8), new Point(10, 10)],
        [new Rectangle(2, 2, 12, 12), new Point(10, 10)],
        [new Rectangle(-4, 14, 14, 14), new Point(4, 4)],
      ];
      for each (var f:Array in filters) {
        for each (var r:Array in rects) {
          probe(f[0], f[1], r[0], r[1]);
        }
      }
    }
  }
}
