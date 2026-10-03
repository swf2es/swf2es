package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;

  // BitmapData.applyFilter with GradientGlowFilter and GradientBevelFilter
  // against adl: how the blurred alpha, or the bevel's difference, picks a
  // colour from the gradient; types, knockout, strength, offsets along the
  // axes, a half-transparent source, gradients of few or odd stops, rects.
  public class GradientFilters extends Sprite {

    private function line(label:String, f:BitmapFilter, color:uint = 0xff00aa00):void {
      var src:BitmapData = new BitmapData(30, 30, true, 0);
      src.fillRect(new Rectangle(10, 10, 10, 10), color);
      var dst:BitmapData = new BitmapData(30, 30, true, 0);
      dst.applyFilter(src, src.rect, new Point(0, 0), f);
      var row:Array = [];
      for (var x:int = 2; x <= 27; x++) row.push(hex(dst.getPixel32(x, 14)));
      trace(label);
      trace(" row", row.join(" "));
      var col:Array = [];
      for (var y:int = 2; y <= 27; y++) col.push(hex(dst.getPixel32(16, y)));
      trace(" col", col.join(" "));
    }

    private function hex(p:uint):String {
      return p == 0 ? "0" : p.toString(16);
    }

    public function GradientFilters() {
      var rgb:Array = [0xff0000, 0x00ff00, 0x0000ff];
      var ones:Array = [1, 1, 1];
      var spread:Array = [0, 128, 255];
      // Glows.
      line("glow default", new GradientGlowFilter());
      line("glow rgb", new GradientGlowFilter(0, 0, rgb, ones, spread, 6, 6, 1, 1, "outer"));
      line("glow rgb strength 2", new GradientGlowFilter(0, 0, rgb, ones, spread, 6, 6, 2, 1, "outer"));
      line("glow rgb inner", new GradientGlowFilter(0, 0, rgb, ones, spread, 6, 6, 1, 1, "inner"));
      line("glow rgb full", new GradientGlowFilter(0, 0, rgb, ones, spread, 6, 6, 1, 1, "full"));
      line("glow rgb knockout", new GradientGlowFilter(0, 0, rgb, ones, spread, 6, 6, 1, 1, "outer", true));
      line("glow rgb inner knockout", new GradientGlowFilter(0, 0, rgb, ones, spread, 6, 6, 1, 1, "inner", true));
      line("glow rgb full knockout", new GradientGlowFilter(0, 0, rgb, ones, spread, 6, 6, 1, 1, "full", true));
      line("glow alphas", new GradientGlowFilter(0, 0, [0xffffff, 0xff0000], [0, 1], [0, 255], 8, 8, 1, 1, "outer"));
      line("glow half alphas", new GradientGlowFilter(0, 0, [0xff0000, 0x0000ff], [0.5, 0.25], [0, 255], 8, 8, 1, 1, "full"));
      line("glow narrow", new GradientGlowFilter(0, 0, rgb, ones, [100, 120, 140], 8, 8, 1, 1, "outer"));
      line("glow one stop", new GradientGlowFilter(0, 0, [0xff8000], [1], [128], 6, 6, 1, 1, "outer"));
      line("glow offset 3 a0", new GradientGlowFilter(3, 0, rgb, ones, spread, 4, 4, 1, 1, "outer"));
      line("glow offset -2.5 a90", new GradientGlowFilter(-2.5, 90, rgb, ones, spread, 4, 4, 1, 1, "full"));
      line("glow quality 2", new GradientGlowFilter(0, 0, rgb, ones, spread, 4, 4, 1, 2, "outer"));
      line("glow half source", new GradientGlowFilter(0, 0, rgb, ones, spread, 6, 6, 1, 1, "outer"), 0x8000aa00);
      line("glow half source inner", new GradientGlowFilter(0, 0, rgb, ones, spread, 6, 6, 1, 1, "inner"), 0x8000aa00);
      line("glow half source full", new GradientGlowFilter(0, 0, rgb, ones, spread, 6, 6, 1, 1, "full"), 0x8000aa00);
      // Bevels.
      line("bevel default", new GradientBevelFilter());
      line("bevel rgb a0", new GradientBevelFilter(3, 0, rgb, ones, spread, 2, 2, 1, 1, "inner"));
      line("bevel rgb a90 strength 2", new GradientBevelFilter(3, 90, rgb, ones, spread, 4, 4, 2, 1, "inner"));
      line("bevel rgb sharp", new GradientBevelFilter(2, 0, rgb, ones, spread, 0, 0, 1, 1, "inner"));
      line("bevel rgb outer", new GradientBevelFilter(3, 0, rgb, ones, spread, 2, 2, 1, 1, "outer"));
      line("bevel rgb full", new GradientBevelFilter(3, 180, rgb, ones, spread, 2, 2, 1, 1, "full"));
      line("bevel rgb knockout", new GradientBevelFilter(3, 0, rgb, ones, spread, 2, 2, 1, 1, "inner", true));
      line("bevel rgb outer knockout", new GradientBevelFilter(3, 0, rgb, ones, spread, 2, 2, 1, 1, "outer", true));
      line("bevel rgb full knockout", new GradientBevelFilter(3, 0, rgb, ones, spread, 2, 2, 1, 1, "full", true));
      line("bevel alphas", new GradientBevelFilter(3, 0, [0xffffff, 0x808080, 0], [1, 0, 1], spread, 2, 2, 1, 1, "full"));
      line("bevel middle alpha", new GradientBevelFilter(3, 90, [0xffffff, 0xff0000, 0], [1, 1, 1], spread, 2, 2, 1, 1, "full"));
      line("bevel uneven", new GradientBevelFilter(3, 0, [0xffffff, 0xff0000, 0x00ff00, 0], [1, 1, 1, 1], [0, 64, 200, 255], 4, 4, 1, 1, "full"));
      line("bevel half source", new GradientBevelFilter(3, 0, rgb, ones, spread, 2, 2, 1, 1, "inner"), 0x8000aa00);
      line("bevel half source outer", new GradientBevelFilter(3, 0, rgb, ones, spread, 2, 2, 1, 1, "outer"), 0x8000aa00);

      var r:Rectangle = new Rectangle(10, 10, 20, 20);
      var b:BitmapData = new BitmapData(80, 80);
      trace("rect", b.generateFilterRect(r, new GradientGlowFilter()), b.generateFilterRect(r, new GradientGlowFilter(6, 30, rgb, ones, spread, 3, 5, 1, 2)),
        b.generateFilterRect(r, new GradientGlowFilter(6, 30, rgb, ones, spread, 3, 5, 1, 2, "full")),
        b.generateFilterRect(r, new GradientBevelFilter()), b.generateFilterRect(r, new GradientBevelFilter(6, 30, rgb, ones, spread, 3, 5, 1, 2)),
        b.generateFilterRect(r, new GradientBevelFilter(-3.5, 210, rgb, ones, spread, 2, 2, 1, 1, "outer")));
    }
  }
}
