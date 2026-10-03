package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;

  // BitmapData.applyFilter and generateFilterRect against adl: the blur's
  // kernel at sizes and qualities, glows and shadows outer, inner and
  // knocked out, a colour matrix, and where a filter writes, in place too.
  public class ApplyFilter extends Sprite {

    private function row(label:String, filter:BitmapFilter, srcColor:uint = 0xff00ff00):void {
      var src:BitmapData = new BitmapData(40, 40, true, 0);
      src.fillRect(new Rectangle(15, 15, 10, 10), srcColor);
      var dst:BitmapData = new BitmapData(40, 40, true, 0);
      dst.applyFilter(src, src.rect, new Point(0, 0), filter);
      var out:Array = [];
      for (var x:int = 8; x <= 31; x++) out.push(dst.getPixel32(x, 20).toString(16));
      trace(label, out.join(" "));
      var col:Array = [];
      for (var y:int = 8; y <= 31; y++) col.push(dst.getPixel32(28, y).toString(16));
      trace(label + " col28", col.join(" "));
    }

    private function dump(label:String, b:BitmapData):void {
      trace(label);
      for (var y:int = 0; y < b.height; y++) {
        var row:Array = [];
        for (var x:int = 0; x < b.width; x++) {
          var p:uint = b.getPixel32(x, y);
          row.push(p == 0xff0000ff ? "." : p == 0 ? "0" : p.toString(16));
        }
        trace(" " + row.join(" "));
      }
    }
    private function kernels():void {
      var cases:Array = [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [8, 1], [4, 2], [4, 3], [6, 3], [2.5, 1], [10, 1], [16, 2]];
      for each (var c:Array in cases) {
        var src:BitmapData = new BitmapData(80, 3, true, 0);
        src.setPixel32(40, 1, 0xffffffff);
        var dst:BitmapData = new BitmapData(80, 3, true, 0);
        dst.applyFilter(src, src.rect, new Point(0, 0), new BlurFilter(c[0], 0, c[1]));
        var row:Array = [];
        for (var x:int = 20; x <= 60; x++) {
          var a:uint = dst.getPixel32(x, 1) >>> 24;
          if (a) row.push((x - 40) + ":" + a);
        }
        trace("blurX", c[0], "q", c[1], row.join(" "));
      }
      var wide:BitmapData = new BitmapData(80, 3, true, 0);
      wide.fillRect(new Rectangle(30, 1, 20, 1), 0xffffffff);
      var out:BitmapData = new BitmapData(80, 3, true, 0);
      out.applyFilter(wide, wide.rect, new Point(0, 0), new BlurFilter(4, 0, 1));
      var r:Array = [];
      for (var i:int = 24; i <= 56; i++) r.push(out.getPixel32(i, 1) >>> 24);
      trace("wide 4 q1", r.join(" "));
      trace("rect", new BitmapData(80, 80).generateFilterRect(new Rectangle(10, 10, 20, 20), new BlurFilter(4, 4, 1)),
        new BitmapData(80, 80).generateFilterRect(new Rectangle(10, 10, 20, 20), new BlurFilter(4, 4, 3)),
        new BitmapData(80, 80).generateFilterRect(new Rectangle(10, 10, 20, 20), new BlurFilter(5, 5, 2)));
        }

    private function glows():void {
      row("glow", new GlowFilter(0xff0000, 1, 4, 4, 2, 1));
      row("glow a.5 s1", new GlowFilter(0xff0000, 0.5, 4, 4, 1, 1));
      row("glow s8", new GlowFilter(0xff0000, 1, 6, 6, 8, 1));
      row("glow inner", new GlowFilter(0xff0000, 1, 4, 4, 2, 1, true));
      row("glow knockout", new GlowFilter(0xff0000, 1, 4, 4, 2, 1, false, true));
      row("glow inner knockout", new GlowFilter(0xff0000, 1, 4, 4, 2, 1, true, true));
      row("glow halfsrc", new GlowFilter(0xff0000, 1, 4, 4, 2, 1), 0x8000ff00);
      row("shadow", new DropShadowFilter(4, 45, 0, 1, 4, 4, 1, 1));
      row("shadow d3 a0", new DropShadowFilter(3, 0, 0x0000ff, 1, 0, 0, 1, 1));
      row("shadow d2.5 a90", new DropShadowFilter(2.5, 90, 0x0000ff, 1, 0, 0, 1, 1));
      row("shadow hide", new DropShadowFilter(4, 0, 0, 1, 2, 2, 1, 1, false, false, true));
      row("shadow inner", new DropShadowFilter(4, 0, 0, 1, 2, 2, 1, 1, true));
      row("blur", new BlurFilter(4, 4, 1));
      row("cm", new ColorMatrixFilter([0.5, 0, 0, 0, 100, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.5, 10]));
      row("cm half", new ColorMatrixFilter([0.5, 0, 0, 0, 100, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.5, 10]), 0x8000ff00);
        }

    private function regions():void {
      var src:BitmapData = new BitmapData(20, 20, true, 0);
      src.fillRect(new Rectangle(7, 7, 6, 6), 0x80ff0000);
      src.setPixel32(12, 9, 0xff00ff00);
      var dst:BitmapData = new BitmapData(18, 16, true, 0xff0000ff);
      dst.applyFilter(src, new Rectangle(5, 5, 10, 10), new Point(2, 3), new BlurFilter(4, 2, 2));
      dump("blur", dst);
      trace("rect", dst.generateFilterRect(new Rectangle(5, 5, 10, 10), new BlurFilter(4, 2, 2)));
      var dst2:BitmapData = new BitmapData(18, 16, true, 0xff0000ff);
      dst2.applyFilter(src, new Rectangle(5, 5, 10, 10), new Point(2, 3), new GlowFilter(0xffff00, 1, 3, 3, 2, 1));
      dump("glow", dst2);
      var self:BitmapData = src.clone();
      self.applyFilter(self, self.rect, new Point(0, 0), new BlurFilter(2, 2, 1));
      trace("self", self.getPixel32(7, 7).toString(16), self.getPixel32(6, 6).toString(16), self.getPixel32(12, 9).toString(16));
      var opaque:BitmapData = new BitmapData(10, 1, false, 0x000000);
      opaque.setPixel(5, 0, 0xffffff);
      opaque.applyFilter(opaque, opaque.rect, new Point(0, 0), new BlurFilter(4, 0, 1));
      var o:Array = [];
      for (var i:int = 0; i < 10; i++) o.push(opaque.getPixel32(i, 0).toString(16));
      trace("opaque", o.join(" "));
        }

    private function rects():void {
      var b:BitmapData = new BitmapData(400, 400);
      var r:Rectangle = new Rectangle(150, 150, 20, 20);
      var grown:Function = function(f:BitmapFilter):String {
        var g:Rectangle = b.generateFilterRect(r, f);
        return [r.x - g.x, r.y - g.y, g.right - r.right, g.bottom - r.bottom].join(",");
      };
      var blurs:Array = [0, 0.5, 2, 2.5, 4, 4.5, 6, 7.5, 15.3, 100, 255];
      for each (var q:int in [0, 1, 2, 3, 7, 15]) {
        var row:Array = [];
        for each (var bl:Number in blurs) {
          row.push(grown(new BlurFilter(bl, bl / 2, q)) + "/" + grown(new GlowFilter(0, 1, bl, bl / 2, 1, q)));
        }
        trace("rects q" + q, row.join(" "));
      }
      var shadows:Array = [];
      for each (var a:Number in [0, 90, 210, -45]) {
        for each (var d:Number in [3.5, -3.5]) {
          shadows.push(grown(new DropShadowFilter(d, a, 0, 1, 2, 2, 1, 1)) + "/" +
            grown(new DropShadowFilter(d, a, 0, 1, 2, 2, 1, 1, true)));
        }
      }
      trace("shadow rects", shadows.join(" "));
      // A glow with no blur still writes a ring a pixel wide.
      var src:BitmapData = new BitmapData(10, 10, true, 0);
      src.fillRect(new Rectangle(3, 3, 4, 4), 0xff00ff00);
      var dst:BitmapData = new BitmapData(10, 10, true, 0xff0000ff);
      dst.applyFilter(src, new Rectangle(3, 3, 4, 4), new Point(3, 3), new GlowFilter(0xff0000, 1, 0, 0, 1, 1));
      dump("glow 0", dst);
      // A rect that cuts the source: the filters read past it.
      var cut:BitmapData = new BitmapData(16, 16, true, 0);
      cut.fillRect(new Rectangle(4, 4, 8, 8), 0xff00aa00);
      for each (var cf:BitmapFilter in [new BlurFilter(4, 4, 1), new GlowFilter(0xff0000, 1, 4, 4, 2, 1),
          new DropShadowFilter(3, 90, 0, 1, 2, 2, 1, 1)]) {
        var into:BitmapData = new BitmapData(16, 14, true, 0xff0000ff);
        into.applyFilter(cut, new Rectangle(3, 3, 9, 6), new Point(2, 3), cf);
        dump("cut " + cf, into);
      }
      // A blur's passes spread past its rect, which cuts them.
      var one:BitmapData = new BitmapData(80, 3, true, 0);
      one.setPixel32(40, 1, 0xffffffff);
      var wide:BitmapData = new BitmapData(80, 3, true, 0);
      wide.applyFilter(one, new Rectangle(40, 1, 1, 1), new Point(40, 1), new BlurFilter(20, 0, 3));
      var out:Array = [];
      for (var x:int = 6; x <= 74; x++) out.push(wide.getPixel32(x, 1) >>> 24);
      trace("blur 20 q3", out.join(" "));
    }

    public function ApplyFilter() {
      kernels();
      glows();
      regions();
      rects();
    }
  }
}
