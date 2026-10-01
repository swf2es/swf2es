// BitmapData's pixel operations on the store alone, where Ruffle's corpus
// covers them thinly: merge, colorTransform with fractions and offsets,
// copyChannel into and out of alpha and an opaque bitmap, scroll, noise's
// options, threshold's comparisons and copySource, getColorBoundsRect,
// floodFill and histogram. What Flash traces settles each rule.
package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.geom.ColorTransform;
  import flash.geom.Point;
  import flash.geom.Rectangle;

  public class Main extends Sprite {
    public function Main() {
      var a:BitmapData = new BitmapData(2, 1, true, 0x80FF8040);
      var b:BitmapData = new BitmapData(2, 1, true, 0xFF102030);
      b.setPixel32(1, 0, 0x00000000);
      a.merge(b, b.rect, new Point(0, 0), 128, 64, 256, 32);
      dump("merge", a);
      a.merge(b, b.rect, new Point(1, 0), 300, -5, 0, 1000);
      dump("merge clamped", a);

      var c:BitmapData = new BitmapData(3, 1, true, 0xC0804020);
      c.setPixel32(1, 0, 0x40FF00FF);
      c.setPixel32(2, 0, 0x00000000);
      c.colorTransform(c.rect, new ColorTransform(0.5, 1.5, 0.3, 0.75, 10, -20, 300, 5));
      dump("colorTransform", c);
      var o:BitmapData = new BitmapData(2, 1, false, 0x336699);
      o.colorTransform(o.rect, new ColorTransform(1, 1, 1, 0.25, 0, 0, 0, -100));
      dump("colorTransform opaque", o);

      var src:BitmapData = new BitmapData(3, 1, true, 0x80FF8040);
      src.setPixel32(1, 0, 0xFF00FF00);
      src.setPixel32(2, 0, 0x20123456);
      var d1:BitmapData = new BitmapData(3, 1, true, 0xFF000000);
      d1.copyChannel(src, src.rect, new Point(0, 0), 8, 1);
      dump("alpha to red", d1);
      var d2:BitmapData = new BitmapData(3, 1, true, 0xFF808080);
      d2.copyChannel(src, src.rect, new Point(0, 0), 1, 8);
      dump("red to alpha", d2);
      var d3:BitmapData = new BitmapData(3, 1, false, 0x808080);
      d3.copyChannel(src, src.rect, new Point(0, 0), 2, 8);
      dump("to alpha opaque", d3);
      d3.copyChannel(src, src.rect, new Point(0, 0), 3, 4);
      dump("two channels", d3);

      var sc:BitmapData = new BitmapData(3, 3, true, 0);
      for (var i:int = 0; i < 9; i++) sc.setPixel32(i % 3, int(i / 3), 0xFF000000 | i);
      sc.scroll(1, -1);
      dump("scroll", sc);

      var t:BitmapData = new BitmapData(4, 1, true, 0);
      var ts:BitmapData = new BitmapData(4, 1, true, 0xFF000000);
      ts.setPixel32(0, 0, 0x80FF0000);
      ts.setPixel32(1, 0, 0xFF00FF00);
      ts.setPixel32(2, 0, 0x00000000);
      for each (var op:String in ["<", "<=", ">", ">=", "==", "!="]) {
        t.fillRect(t.rect, 0x11223344);
        var n:uint = t.threshold(ts, ts.rect, new Point(0, 0), op, 0x80FF0000, 0xFFFFFFFF, 0xFF00FF00, true);
        dump("threshold " + op + " " + n, t);
      }

      var bounds:BitmapData = new BitmapData(4, 4, true, 0xFFFFFFFF);
      bounds.setPixel32(3, 3, 0xFF00FF00);
      trace("bounds lone corner", bounds.getColorBoundsRect(0xFFFFFFFF, 0xFFFFFFFF, false));
      bounds.setPixel32(0, 0, 0xFF00FF00);
      trace("bounds two", bounds.getColorBoundsRect(0xFFFFFFFF, 0xFF00FF00, true));
      var single:BitmapData = new BitmapData(4, 4, true, 0xFFFFFFFF);
      single.setPixel32(0, 0, 0xFF00FF00);
      trace("bounds origin", single.getColorBoundsRect(0xFFFFFFFF, 0xFF00FF00, true));
      single.setPixel32(1, 0, 0xFF00FF00);
      trace("bounds origin and one", single.getColorBoundsRect(0xFFFFFFFF, 0xFF00FF00, true));

      var f:BitmapData = new BitmapData(4, 3, true, 0xFFFFFFFF);
      f.setPixel32(1, 0, 0xFF000000);
      f.setPixel32(1, 1, 0xFF000000);
      f.setPixel32(2, 2, 0xFF000000);
      f.floodFill(0, 0, 0xFFFF0000);
      dump("floodFill", f);
      f.floodFill(3, 0, 0x80FF0000);
      dump("floodFill translucent", f);

      var h:Vector.<Vector.<Number>> = src.histogram();
      trace("histogram", h.length, h[0].length, h[0][255], h[0][0], h[1][255], h[3][128], h[3][32]);

      for each (var opts:Array in [[0, 0, 255, 7, false], [7, 50, 60, 15, false], [-1, 0, 255, 8, true], [99, 0, 255, 1, true]]) {
        var nz:BitmapData = new BitmapData(2, 1, true, 0);
        nz.noise(opts[0], opts[1], opts[2], opts[3], opts[4]);
        dump("noise " + opts.join(","), nz);
      }
    }

    private function dump(label:String, bd:BitmapData):void {
      var s:String = label + ":";
      for (var y:int = 0; y < bd.height; y++) for (var x:int = 0; x < bd.width; x++) s += " " + bd.getPixel32(x, y).toString(16);
      trace(s);
    }
  }
}
