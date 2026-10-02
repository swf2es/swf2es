package {
  import flash.display.BitmapData;
  import flash.display.JPEGEncoderOptions;
  import flash.display.PNGEncoderOptions;
  import flash.display.Sprite;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  // BitmapData.encode as PNG (cases.ts): the file, into a ByteArray given at
  // a position and into a new one, and what the method refuses. Fast
  // compression is byte for byte Flash's; the default's deflate differs, so
  // only its header is traced.
  public class BitmapEncode extends Sprite {
    public function BitmapEncode() {
      var bd:BitmapData = new BitmapData(3, 2, true, 0x80FF8040);
      bd.setPixel32(1, 0, 0xFF102030);
      bd.setPixel32(2, 1, 0x00000000);

      var made:ByteArray = bd.encode(bd.rect, new PNGEncoderOptions(true));
      trace("new", made.length, made.position, made.endian);
      trace("fast", hex(made, 0, made.length));

      var into:ByteArray = new ByteArray();
      into.writeUTFBytes("abcdef");
      into.position = 2;
      var back:ByteArray = bd.encode(bd.rect, new PNGEncoderOptions(true), into);
      trace("into", back == into, into.length, into.position, hex(into, 0, 4), hex(into, 2 + made.length - 4, 4));

      var opaque:BitmapData = new BitmapData(2, 1, false, 0x123456);
      var rgb:ByteArray = opaque.encode(opaque.rect, new PNGEncoderOptions(true));
      trace("opaque", hex(rgb, 0, rgb.length));

      var whole:ByteArray = bd.encode(new Rectangle(0.5, 0.5, 2.4, 1.6), new PNGEncoderOptions());
      trace("default header", hex(whole, 0, 33));

      var clipped:ByteArray = bd.encode(new Rectangle(-1, 1, 10, 10), new PNGEncoderOptions(true));
      trace("clipped", hex(clipped, 0, 33));

      probe("null rect", function():* { bd.encode(null, new PNGEncoderOptions()); });
      probe("null compressor", function():* { bd.encode(bd.rect, null); });
      probe("object compressor", function():* { bd.encode(bd.rect, {}); });
      probe("empty rect", function():* { bd.encode(new Rectangle(0, 0, 0, 0), new PNGEncoderOptions()); });
      probe("outside", function():* { bd.encode(new Rectangle(10, 10, 2, 2), new PNGEncoderOptions()); });
      var gone:BitmapData = new BitmapData(1, 1);
      gone.dispose();
      probe("disposed", function():* { gone.encode(new Rectangle(0, 0, 1, 1), new PNGEncoderOptions()); });
    }

    private static function probe(name:String, f:Function):void {
      try {
        f();
        trace(name, "ok");
      } catch (e:Error) {
        trace(name, Object(e).constructor, e.errorID);
      }
    }

    private static function hex(b:ByteArray, from:int, count:int):String {
      var out:String = "";
      for (var i:int = from; i < from + count; i++) {
        var s:String = b[i].toString(16);
        out += s.length < 2 ? "0" + s : s;
      }

      return out;
    }
  }
}
