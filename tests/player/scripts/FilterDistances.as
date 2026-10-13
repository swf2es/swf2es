// What adl makes of a shadow's, a gradient glow's and a bevel's distance
// past what it can hold, and of NaN: each part of the offset kept in 256ths
// in an int, wrapping round at 2^23 - 1 and stopping at -2^23 - 256, so
// generateFilterRect reaches -8388866; an outer shadow so cast writes
// nothing, not even what it shadows; a distance or angle of NaN refuses an
// outer shadow (2015) and is none for the rest; a filter rect past adl's
// buffers is refused, 2015 for a shadow, 2077 for a bevel. An inner one's
// generateFilterRect lies within the bitmap. draw's matrix moves in twips in
// an int, NaN and past the int's range at 0; hitTest refuses a point the
// bitmap would reach past the int's range from (1508). A hole in a
// gradient's arrays is 0.
package {
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.filters.BevelFilter;
  import flash.filters.BitmapFilter;
  import flash.filters.DropShadowFilter;
  import flash.filters.GlowFilter;
  import flash.filters.GradientBevelFilter;
  import flash.filters.GradientGlowFilter;
  import flash.geom.Matrix;
  import flash.geom.Point;
  import flash.geom.Rectangle;
  import flash.utils.getQualifiedClassName;

  public class Main extends Sprite {
    public function Main() {
      var ang:Number;
      var f:BitmapFilter;
      // Cast left or up some 2^15 pixels and more, adl draws an outer shadow
      // in pieces as its 16-bit sums wrap, which is left out; so is a small
      // distance off the axes, which it reads a 256th further out.
      for each (var c:Array in [[1000, [0, 45, 90, 30, NaN]], [1e5, [0, 45, 90, 30, NaN]], [4e6, [0, 45, 90, 30, NaN]],
          [8388607, [0, 45, 90, 30, NaN]], [8388900, [0, 45, 90, 30, NaN]], [1e9, [0, 45, 90, 30, NaN]], [2147483648, [0, 45, 90, 30, NaN]],
          [1e20, [0, 45, 90, 30, NaN]], [Infinity, [0, 45, 90, 30, NaN]], [-Infinity, [0, 45, 90, 30, NaN]], [-8388900, [0, 45, 90, 30, NaN]],
          [-1e9, [0, 45, 90, 30, NaN]], [NaN, [0, 45, 90, 30, NaN]], [3, [0, 90, 180, NaN]], [1000, [180]]]) {
        for each (ang in c[1]) {
          for each (f in shadows(c[0], ang)) {
            trace(c[0], ang, kind(f), applied(f));
          }
        }
      }

      // generateFilterRect: distances that wrap at 180° and stop, and inner filters within the bitmap.
      for each (c in [[3, [180, 270, 45]], [1000, [180, 270, 45]], [8388607, [180, 45]], [8388609, [180, 45]], [8388900, [180, 45]]]) {
        for each (ang in c[1]) {
          for each (f in shadows(c[0], ang)) {
            trace("rect", c[0], ang, kind(f), grown(new BitmapData(40, 40, true, 0), new Rectangle(0, 0, 8, 8), f));
          }
        }
      }
      for each (f in [new GlowFilter(0xff, 1, 6, 6, 2, 1, true), new GlowFilter(0xff, 1, 6, 6, 2, 1, false, true),
          new DropShadowFilter(4, 45, 0, 1, 4, 4, 1, 1, false, true), new DropShadowFilter(4, 45, 0, 1, 4, 4, 1, 1, true, true),
          new BevelFilter(4, 45, 0xff, 1, 0, 1, 4, 4, 1, 1, "outer"), new BevelFilter(4, 45, 0xff, 1, 0, 1, 4, 4, 1, 1, "full"),
          new BevelFilter(4, 45, 0xff, 1, 0, 1, 4, 4, 1, 1, "inner", true), new GradientGlowFilter(4, 45, [0, 0xff], [0, 1], [0, 255], 4, 4, 1, 1, "full"),
          new GradientGlowFilter(4, 45, [0, 0xff], [0, 1], [0, 255], 4, 4, 1, 1, "inner"),
          new GradientBevelFilter(4, 45, [0, 0xff], [1, 1], [0, 255], 4, 4, 1, 1, "outer"), new GlowFilter(0xff, 1, 0, 0, 2, 1, true)]) {
        var g:BitmapData = new BitmapData(40, 40, true, 0);
        trace("inner rect", kind(f), grown(g, new Rectangle(2, 3, 8, 8), f), grown(g, new Rectangle(36, 35, 8, 8), f),
          grown(g, new Rectangle(-30, 3, 8, 8), f));
      }

      // A gradient's arrays with holes, or a length set far past their end: a hole is 0.
      var holes:Array = [];
      holes[2] = 0xff;
      var alphas:Array = [];
      alphas[1] = 1;
      var ratios:Array = [];
      ratios[2] = 255;
      var long:Array = [0xff0000, 0xff];
      long.length = 1000000;
      for each (var set:Array in [[holes, [1, 1, 1], [0, 128, 255]], [[0, 0xff], alphas, [0, 255]], [[0, 0xff, 0xff00], [1, 1, 1], ratios],
          [long, long, long]]) {
        var gg:GradientGlowFilter = new GradientGlowFilter(4, 45, set[0], set[1], set[2], 4, 4, 1, 1, "outer");
        trace("stops", gg.colors, "|", gg.alphas, "|", gg.ratios, "|", applied(gg));
      }

      // draw's matrix: NaN, Infinity and past the int's range in twips move to 0; near its
      // ends they wrap round to near 0; a matrix that scales draws them nowhere but NaN.
      var sh:Shape = new Shape();
      sh.graphics.beginFill(0xff0000);
      sh.graphics.drawRect(0, 0, 4, 4);
      var bmp:BitmapData = new BitmapData(4, 4, false, 0xff0000);
      for each (var t:Number in [NaN, Infinity, -Infinity, 1e300, 1e20, 4294967298, 2147483648, 107374184, 107374182.4, 107374181,
          107374180, 1e8, -1e8, -107374181, -107374182.5, -1e300, 2.5]) {
        var s:String = "";
        for each (var k:int in [4, 5]) {
          var m:Array = [1, 0, 0, 1, 10, 10];
          m[k] = t;
          var d:BitmapData = new BitmapData(40, 40, true, 0);
          d.draw(sh, new Matrix(m[0], m[1], m[2], m[3], m[4], m[5]));
          s += " shape " + box(d);
          d = new BitmapData(40, 40, true, 0);
          d.draw(bmp, new Matrix(m[0], m[1], m[2], m[3], m[4], m[5]));
          s += " bitmap " + box(d);
        }
        d = new BitmapData(40, 40, true, 0);
        d.drawWithQuality(sh, new Matrix(2, 0, 0, 2, t, 3), null, null, null, false, "low");
        trace("draw", t, s, "scaled", box(d));
      }

      // hitTest: the first point, or the second bitmap's, past the int's range less the bitmap's size.
      var a:BitmapData = new BitmapData(8, 5, true, 0xffffffff);
      var b:BitmapData = new BitmapData(100, 30, true, 0xffffffff);
      for each (var p:Number in [2147483639, 2147483640, 2147483642, 2147483643, 2147483547, 2147483548, 2147483617, 2147483618,
          2147483648, NaN, -2147483648]) {
        s = "";
        for each (var bd:BitmapData in [a, b]) {
          s += " x " + hit(bd, new Point(p, 0), new Point(0, 0)) + " y " + hit(bd, new Point(0, p), new Point(0, 0))
            + " rect " + hit(bd, new Point(p, 0), new Rectangle(0, 0, 2, 2)) + " second " + hit(bd, new Point(0, 0), new Point(p, 0))
            + " bitmap " + hit(bd, new Point(0, 0), b, new Point(p, 0)) + " bitmap y " + hit(bd, new Point(0, 0), b, new Point(0, p));
        }
        trace("hitTest", p, s);
      }
    }

    private function shadows(dist:Number, ang:Number):Array {
      return [new DropShadowFilter(dist, ang, 0, 1, 2, 2, 1, 1), new DropShadowFilter(dist, ang, 0, 1, 2, 2, 1, 1, true),
        new BevelFilter(dist, ang, 0xffffff, 1, 0, 1, 2, 2, 1, 1), new GradientGlowFilter(dist, ang, [0, 0xffffff], [0, 1], [0, 255], 2, 2, 1, 1, "outer"),
        new GradientGlowFilter(dist, ang, [0, 0xffffff], [0, 1], [0, 255], 2, 2, 1, 1, "inner"),
        new GradientBevelFilter(dist, ang, [0, 0xffffff], [1, 1], [0, 255], 2, 2, 1, 1, "inner")];
    }

    private function kind(f:BitmapFilter):String {
      var name:String = getQualifiedClassName(f).split("::")[1];
      var o:Object = f;
      return name + ("inner" in o && o.inner ? " inner" : "") + ("type" in o ? " " + o.type : "");
    }

    /** applyFilter of a red square on blue: the pixels' hash, or the error. */
    private function applied(f:BitmapFilter):String {
      var d:BitmapData = new BitmapData(8, 8, true, 0xff0000ff);
      var src:BitmapData = new BitmapData(8, 8, true, 0);
      src.fillRect(new Rectangle(2, 2, 4, 4), 0xffff0000);
      try {
        d.applyFilter(src, src.rect, new Point(0, 0), f);
      } catch (e:Error) {
        return "error " + e.errorID;
      }
      var n:Number = 0;
      for (var y:int = 0; y < 8; y++) {
        for (var x:int = 0; x < 8; x++) {
          n = (n * 31 + (d.getPixel32(x, y) >>> 0)) % 1000000007;
        }
      }
      return String(n);
    }

    private function grown(bd:BitmapData, r:Rectangle, f:BitmapFilter):String {
      var g:Rectangle = bd.generateFilterRect(r, f);
      return g.x + "," + g.y + "," + g.width + "," + g.height;
    }

    private function box(bd:BitmapData):String {
      var r:Rectangle = bd.getColorBoundsRect(0xff000000, 0, false);
      return r.x + "," + r.y + "," + r.width + "," + r.height;
    }

    private function hit(bd:BitmapData, first:Point, second:Object, secondPoint:Point = null):String {
      try {
        return String(bd.hitTest(first, 1, second, secondPoint));
      } catch (e:Error) {
        return "error " + e.errorID;
      }
      return null;
    }
  }
}
