package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;
  import flash.utils.getQualifiedClassName;

  // BitmapData.applyFilter and generateFilterRect with a BevelFilter
  // against adl: inner, outer and full, knocked out, at angles and
  // distances whole and fractional, blurred or not, of a half-transparent
  // source too, and where it writes; along the axes, where swf2es reads as
  // adl does (bevel-draw has the angles between, within a level or two).
  public class Bevel extends Sprite {

    private function line(label:String, f:BevelFilter, color:uint = 0xff00aa00, transparent:Boolean = true):void {
      var src:BitmapData = new BitmapData(30, 30, true, 0);
      src.fillRect(new Rectangle(10, 10, 10, 10), color);
      var dst:BitmapData = new BitmapData(30, 30, transparent, transparent ? 0 : 0xff808080);
      try {
        dst.applyFilter(src, src.rect, new Point(0, 0), f);
      } catch (e:Error) {
        trace(label, e.errorID, e.message);
        return;
      }
      var row:Array = [];
      for (var x:int = 4; x <= 25; x++) row.push(hex(dst.getPixel32(x, 14)));
      trace(label);
      trace(" row", row.join(" "));
      var col:Array = [];
      for (var y:int = 4; y <= 25; y++) col.push(hex(dst.getPixel32(16, y)));
      trace(" col", col.join(" "));
    }

    private function hex(p:uint):String {
      return p == 0 ? "0" : p.toString(16);
    }

    private function dump(label:String, b:BitmapData):void {
      trace(label);
      for (var y:int = 0; y < b.height; y++) {
        var row:Array = [];
        for (var x:int = 0; x < b.width; x++) {
          var p:uint = b.getPixel32(x, y);
          row.push(p == 0xff0000ff ? "." : hex(p));
        }
        trace(" " + row.join(" "));
      }
    }

    public function Bevel() {
      line("default at 0", new BevelFilter(4, 0));
      line("sharp d1 a0", new BevelFilter(1, 0, 0xffffff, 1, 0, 1, 0, 0, 1, 1));
      line("sharp d2 a90", new BevelFilter(2, 90, 0xff0000, 1, 0x0000ff, 1, 0, 0, 1, 1));
      line("sharp d1 a180", new BevelFilter(1, 180, 0xffffff, 1, 0, 1, 0, 0, 1, 1));
      line("sharp d2.5 a-90", new BevelFilter(2.5, -90, 0xffffff, 1, 0, 1, 0, 0, 1, 1));
      line("sharp d0", new BevelFilter(0, 0, 0xffffff, 1, 0, 1, 0, 0, 1, 1));
      line("sharp d-2", new BevelFilter(-2, 90, 0xffffff, 1, 0, 1, 0, 0, 1, 1));
      line("blur 4 strength 1", new BevelFilter(4, 0, 0xffffff, 1, 0, 1, 4, 4, 1, 1));
      line("blur 4 strength 2", new BevelFilter(4, 90, 0xffffff, 1, 0, 1, 4, 4, 2, 1));
      line("blur 6 strength 0.5", new BevelFilter(3, 180, 0xffffff, 1, 0, 1, 6, 6, 0.5, 1));
      line("blur 4 quality 2", new BevelFilter(3.5, 0, 0xffffff, 1, 0, 1, 4, 4, 1, 2));
      line("blur 5x2", new BevelFilter(3, 0, 0xffff00, 1, 0xff00ff, 1, 5, 2, 1, 1));
      line("alphas", new BevelFilter(3, 90, 0xffffff, 0.5, 0, 0.25, 2, 2, 1, 1));
      line("outer", new BevelFilter(3, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1, "outer"));
      line("full", new BevelFilter(3, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1, "full"));
      line("inner knockout", new BevelFilter(3, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1, "inner", true));
      line("outer knockout", new BevelFilter(3, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1, "outer", true));
      line("full knockout", new BevelFilter(3, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1, "full", true));
      line("half source", new BevelFilter(3, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1), 0x8000aa00);
      line("half source outer", new BevelFilter(3, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1, "outer"), 0x8000aa00);
      line("half source full", new BevelFilter(3, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1, "full"), 0x8000aa00);
      line("into opaque", new BevelFilter(3, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1), 0xff00aa00, false);
      line("into opaque outer", new BevelFilter(3, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1, "outer"), 0xff00aa00, false);
      line("strength 8", new BevelFilter(2.5, 0, 0xff8000, 1, 0x0080ff, 1, 3, 3, 8, 1, "full"));

      // Which filters an opaque destination refuses.
      var kinds:Array = [new BlurFilter(), new GlowFilter(), new DropShadowFilter(), new ColorMatrixFilter(),
        new ConvolutionFilter(3, 3, [1, 1, 1, 1, 1, 1, 1, 1, 1], 9), new BevelFilter(), new GradientGlowFilter(),
        new GradientBevelFilter()];
      for each (var k:BitmapFilter in kinds) {
        var o:BitmapData = new BitmapData(4, 4, false, 0);
        try {
          o.applyFilter(new BitmapData(4, 4, true, 0x80ff0000), o.rect, new Point(0, 0), k);
          trace("opaque", k, "ok");
        } catch (e:Error) {
          trace("opaque", k, e.errorID, getQualifiedClassName(e));
        }
      }

      var r:Rectangle = new Rectangle(10, 10, 20, 20);
      var b:BitmapData = new BitmapData(80, 80);
      trace("rect", b.generateFilterRect(r, new BevelFilter()), b.generateFilterRect(r, new BevelFilter(6, 30, 0, 1, 0, 1, 3, 5, 1, 2)),
        b.generateFilterRect(r, new BevelFilter(6, 30, 0, 1, 0, 1, 3, 5, 1, 2, "outer")),
        b.generateFilterRect(r, new BevelFilter(6, 30, 0, 1, 0, 1, 3, 5, 1, 2, "full")),
        b.generateFilterRect(r, new BevelFilter(0, 0, 0, 1, 0, 1, 0, 0)));

      var src:BitmapData = new BitmapData(16, 16, true, 0);
      src.fillRect(new Rectangle(4, 4, 8, 8), 0xff00aa00);
      src.setPixel32(6, 6, 0x80ff0000);
      var dst:BitmapData = new BitmapData(16, 14, true, 0xff0000ff);
      dst.applyFilter(src, new Rectangle(3, 3, 9, 7), new Point(2, 3), new BevelFilter(2, 0, 0xffffff, 1, 0, 1, 2, 2, 1, 1, "full"));
      dump("subrect", dst);
      var self:BitmapData = src.clone();
      self.applyFilter(self, self.rect, new Point(0, 0), new BevelFilter(2, 90, 0xffffff, 1, 0, 1, 2, 2, 1, 1));
      dump("in place", self);
    }
  }
}
