// BitmapData as a pixel store and Bitmap on the display list, by what Flash
// traces and draws: the constructor's limits, premultiplied pixels read
// back, fillRect, copyPixels with and without merged alpha into transparent
// and opaque bitmaps, getPixels, getVector and setVector, clone, dispose,
// and three Bitmaps drawn at different scales, one smoothed.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.geom.Point;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  public class Main extends Sprite {
    public function Main() {
      probe("tiny", function():* { return new BitmapData(0, 1); });
      probe("wide", function():* { return new BitmapData(8192, 1); });
      probe("edge", function():* { var b:BitmapData = new BitmapData(8191, 1); return b.width + "x" + b.height; });
      probe("area", function():* { return new BitmapData(4096, 4096); });
      probe("area ok", function():* { var b:BitmapData = new BitmapData(4095, 4095); return b.width; });
      probe("8193", function():* { return new BitmapData(8193, 1); });
      probe("16384", function():* { return new BitmapData(16384, 1); });
      probe("tall", function():* { return new BitmapData(1, 8193); });
      probe("4097x4096", function():* { return new BitmapData(4097, 4096); });
      probe("negative", function():* { return new BitmapData(-1, 1); });
      var bd:BitmapData = new BitmapData(4, 3, true, 0x80FF8040);
      trace("size", bd.width, bd.height, bd.transparent, bd.rect);
      trace("default fill", bd.getPixel32(0, 0).toString(16), bd.getPixel(0, 0).toString(16));
      trace("out of range", bd.getPixel32(4, 0), bd.getPixel32(-1, 0), bd.getPixel32(0, 3));
      var samples:Array = [0x01FFFFFF, 0x0180C040, 0x02FFFFFF, 0x7F3366CC, 0x80FF8040, 0xFE123456, 0xFF123456, 0x00123456, 0x10203040, 0xC8C8C8C8];
      for each (var v:uint in samples) {
        bd.setPixel32(1, 1, v);
        trace("roundtrip", v.toString(16), bd.getPixel32(1, 1).toString(16), bd.getPixel(1, 1).toString(16));
      }
      bd.setPixel32(1, 1, 0x80FF0000);
      bd.setPixel(1, 1, 0x00FF00);
      trace("setPixel keeps alpha", bd.getPixel32(1, 1).toString(16));
      var opaque:BitmapData = new BitmapData(4, 3, false, 0x12345678);
      trace("opaque fill", opaque.getPixel32(0, 0).toString(16), opaque.getPixel(0, 0).toString(16));
      opaque.setPixel32(0, 0, 0x40102030);
      trace("opaque set32", opaque.getPixel32(0, 0).toString(16));
      bd.fillRect(new Rectangle(2, 1, 5, 5), 0x40FF0000);
      trace("fillRect clipped", bd.getPixel32(2, 1).toString(16), bd.getPixel32(3, 2).toString(16), bd.getPixel32(1, 1).toString(16), bd.getPixel32(2, 0).toString(16));
      var src:BitmapData = new BitmapData(2, 2, true, 0x80FF0000);
      src.setPixel32(1, 1, 0x4000FF00);
      var dst:BitmapData = new BitmapData(3, 3, true, 0xFF0000FF);
      dst.copyPixels(src, new Rectangle(0, 0, 2, 2), new Point(1, 1));
      trace("copy", dst.getPixel32(1, 1).toString(16), dst.getPixel32(2, 2).toString(16), dst.getPixel32(0, 0).toString(16));
      var merged:BitmapData = new BitmapData(3, 3, true, 0xFF0000FF);
      merged.copyPixels(src, new Rectangle(0, 0, 2, 2), new Point(1, 1), null, null, true);
      trace("merge", merged.getPixel32(1, 1).toString(16), merged.getPixel32(2, 2).toString(16));
      var merged2:BitmapData = new BitmapData(3, 3, true, 0x400000FF);
      merged2.copyPixels(src, new Rectangle(0, 0, 2, 2), new Point(0, 0), null, null, true);
      trace("merge over translucent", merged2.getPixel32(0, 0).toString(16), merged2.getPixel32(1, 1).toString(16));
      var into:BitmapData = new BitmapData(3, 3, false, 0xFF0000FF);
      into.copyPixels(src, new Rectangle(0, 0, 2, 2), new Point(0, 0));
      trace("copy into opaque", into.getPixel32(0, 0).toString(16), into.getPixel32(1, 1).toString(16));
      into.copyPixels(src, new Rectangle(0, 0, 2, 2), new Point(0, 0), null, null, true);
      trace("merge into opaque", into.getPixel32(0, 0).toString(16), into.getPixel32(1, 1).toString(16));
      dst.copyPixels(src, new Rectangle(-1, -1, 10, 10), new Point(-1, -1));
      trace("copy clipped", dst.getPixel32(0, 0).toString(16), dst.getPixel32(1, 1).toString(16));
      var bytes:ByteArray = src.getPixels(new Rectangle(0, 0, 2, 2));
      trace("getPixels", bytes.length, bytes.position);
      bytes.position = 0;
      trace("bytes", bytes.readUnsignedInt().toString(16), bytes.readUnsignedInt().toString(16), bytes.readUnsignedInt().toString(16), bytes.readUnsignedInt().toString(16));
      var vec:Vector.<uint> = src.getVector(new Rectangle(0, 0, 2, 2));
      trace("getVector", vec.length, vec[0].toString(16), vec[3].toString(16));
      var target:BitmapData = new BitmapData(2, 2, true, 0);
      target.setVector(new Rectangle(0, 0, 2, 2), vec);
      trace("setVector", target.getPixel32(0, 0).toString(16), target.getPixel32(1, 1).toString(16));
      probe("setVector short", function():* { target.setVector(new Rectangle(0, 0, 2, 2), new <uint>[1, 2]); return "ok"; });
      bytes.position = 0;
      target.setPixels(new Rectangle(0, 0, 2, 2), bytes);
      trace("setPixels", target.getPixel32(1, 1).toString(16), bytes.position);
      probe("setPixels short", function():* { var b:ByteArray = new ByteArray(); b.writeUnsignedInt(1); target.setPixels(new Rectangle(0, 0, 2, 2), b); return "ok"; });
      var c:BitmapData = src.clone();
      c.setPixel32(0, 0, 0xFFFFFFFF);
      trace("clone", c.getPixel32(0, 0).toString(16), src.getPixel32(0, 0).toString(16), c.width, c.transparent);
      c.dispose();
      probe("disposed width", function():* { return c.width; });
      probe("disposed height", function():* { return c.height; });
      probe("disposed transparent", function():* { return c.transparent; });
      probe("dispose again", function():* { c.dispose(); return "ok"; });
      probe("disposed rect", function():* { return c.rect; });
      probe("disposed getPixel", function():* { return c.getPixel(0, 0); });
      probe("disposed fillRect", function():* { c.fillRect(new Rectangle(0, 0, 1, 1), 0); return "ok"; });
      probe("rect null", function():* { bd.fillRect(null, 0); return "ok"; });

      var shown:BitmapData = new BitmapData(4, 4, true, 0x00000000);
      shown.fillRect(new Rectangle(0, 0, 2, 2), 0xFFFF0000);
      shown.fillRect(new Rectangle(2, 0, 2, 2), 0xFF00FF00);
      shown.fillRect(new Rectangle(0, 2, 2, 2), 0xFF0000FF);
      shown.fillRect(new Rectangle(2, 2, 2, 2), 0x80FFFFFF);
      var a:Bitmap = new Bitmap(shown);
      a.x = 10; a.y = 10; a.scaleX = a.scaleY = 10;
      addChild(a);
      var b:Bitmap = new Bitmap(shown, "auto", true);
      b.x = 70; b.y = 10; b.scaleX = b.scaleY = 10;
      addChild(b);
      var d:Bitmap = new Bitmap();
      trace("empty bitmap", d.bitmapData, d.width, d.height, d.pixelSnapping, d.smoothing);
      d.bitmapData = shown;
      d.x = 130; d.y = 10;
      addChild(d);
      trace("bitmap size", a.width, a.height, b.width, d.width, d.height, a.smoothing, b.smoothing, b.pixelSnapping);
      probe("snapping", function():* { d.pixelSnapping = "sometimes"; return "ok"; });
      shown.setPixel32(0, 0, 0xFF000000);
      trace("drawn", shown.getPixel32(0, 0).toString(16));
    }

    private function probe(label:String, f:Function):void {
      try { trace(label, f()); } catch (e:Error) { trace(label, "error", e.errorID); }
    }
  }
}
