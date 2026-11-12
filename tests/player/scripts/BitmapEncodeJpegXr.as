package {
  import flash.display.BitmapData;
  import flash.display.JPEGXREncoderOptions;
  import flash.display.Sprite;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  // BitmapData.encode as JPEG XR (cases.ts): the files, which are Flash's byte for byte, at
  // the quantizations where Flash's steps change, in each colour space and with flexbits
  // trimmed, opaque and transparent; and what the method refuses, in Flash's order. Flash
  // Player loads no JPEG XR, so nothing is drawn.
  public class BitmapEncodeJpegXr extends Sprite {
    public function BitmapEncodeJpegXr() {
      var options:JPEGXREncoderOptions = new JPEGXREncoderOptions();
      trace("defaults", options.quantization, options.colorSpace, options.trimFlexBits);

      var opaque:BitmapData = picture(40, 24, false);
      var transparent:BitmapData = picture(40, 24, true);
      for each (var q:int in [0, 1, 2, 15, 16, 20, 48, 49, 80, 100]) {
        file("quantization " + q, opaque, new JPEGXREncoderOptions(q));
        file("transparent, quantization " + q, transparent, new JPEGXREncoderOptions(q));
      }

      for each (var space:String in ["auto", "4:4:4", "4:2:2", "4:2:0"]) {
        file(space, opaque, new JPEGXREncoderOptions(30, space));
        file("transparent, " + space, transparent, new JPEGXREncoderOptions(30, space));
        file("lossless " + space, opaque, new JPEGXREncoderOptions(0, space));
      }

      for each (var trim:int in [1, 2, 15]) {
        file("trim " + trim, opaque, new JPEGXREncoderOptions(20, "auto", trim));
      }

      file("transparent, trim 3", transparent, new JPEGXREncoderOptions(20, "auto", 3));
      file("transparent, trim 200", transparent, new JPEGXREncoderOptions(20, "auto", 200));

      // Flat pictures, whole, and a picture wider than 255 macroblocks.
      file("one pixel", new BitmapData(1, 1, false, 0x336699), options, true);
      file("seventeen by nine", new BitmapData(17, 9, false, 0xCC8844), options, true);
      file("grey, lossless", new BitmapData(16, 16, false, 0x808080), new JPEGXREncoderOptions(0), true);
      file("clear", new BitmapData(16, 16, true, 0), options, true);
      file("opaque in transparent", new BitmapData(16, 16, true, 0xFF336699), options, true);
      file("half alpha", new BitmapData(16, 16, true, 0x80FF8040), new JPEGXREncoderOptions(0), true);
      file("wide", new BitmapData(4097, 2, false, 0x336699), options);
      file("tall", new BitmapData(2, 4097, true, 0x80336699), new JPEGXREncoderOptions(50, "4:2:0"));
      file("part", opaque, options, false, new Rectangle(3.5, 2.5, 17.4, 9.6));
      file("clipped", opaque, options, false, new Rectangle(-5, 20, 20, 20));

      var one:BitmapData = new BitmapData(1, 1, false, 0x336699);
      var made:ByteArray = one.encode(one.rect, options);
      trace("new", made.length, made.position, made.endian);
      var into:ByteArray = new ByteArray();
      into.writeUTFBytes("abcdef");
      into.position = 2;
      var back:ByteArray = one.encode(one.rect, options, into);
      trace("into", back == into, into.length, into.position, hex(into, 0, 6));

      probe("quantization 101", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(101)); });
      probe("quantization -1", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(-1)); });
      probe("colour space null", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, null)); });
      probe("colour space empty", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, "")); });
      probe("colour space AUTO", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, "AUTO")); });
      probe("colour space 4:4:0", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, "4:4:0")); });
      probe("trim 16", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, "auto", 16)); });
      probe("trim 255", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, "auto", 255)); });
      probe("trim 256", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, "auto", 256)); });
      probe("trim -1", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, "auto", -1)); });
      probe("transparent, trim 255", function():* { transparent.encode(transparent.rect, new JPEGXREncoderOptions(20, "auto", 255)); });
      probe("transparent, trim 256", function():* { transparent.encode(transparent.rect, new JPEGXREncoderOptions(20, "auto", 256)); });
      probe("quantization 101, colour space null", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(101, null)); });
      probe("quantization 101, trim 256", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(101, "auto", 256)); });
      probe("colour space null, trim 256", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, null, 256)); });
      probe("colour space x, trim 16", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, "x", 16)); });
      probe("null rect, quantization 101", function():* { opaque.encode(null, new JPEGXREncoderOptions(101)); });
      probe("empty rect, colour space null", function():* { opaque.encode(new Rectangle(0, 0, 0, 0), new JPEGXREncoderOptions(20, null)); });
      probe("outside, trim 256", function():* { opaque.encode(new Rectangle(100, 100, 2, 2), new JPEGXREncoderOptions(20, "auto", 256)); });
      var gone:BitmapData = new BitmapData(1, 1);
      gone.dispose();
      probe("disposed, quantization 101", function():* { gone.encode(new Rectangle(0, 0, 1, 1), new JPEGXREncoderOptions(101)); });
      var kept:ByteArray = new ByteArray();
      kept.writeUTFBytes("abcdef");
      kept.position = 2;
      probe("trim 16 into", function():* { opaque.encode(opaque.rect, new JPEGXREncoderOptions(20, "auto", 16), kept); });
      trace("kept", kept.length, kept.position);
    }

    // A gradient with flat areas and a slanted edge; with alpha, it fades out to the right.
    private static function picture(w:int, h:int, transparent:Boolean):BitmapData {
      var bd:BitmapData = new BitmapData(w, h, transparent, 0xFF000000);
      for (var y:int = 0; y < h; y++) {
        for (var x:int = 0; x < w; x++) {
          var r:int = (x * 255) / (w - 1);
          var g:int = (y * 255) / (h - 1);
          var b:int = 255 - r;
          if (x >= 4 && x < 20 && y >= 4 && y < 12) {
            r = 200; g = 40; b = 90;
          }
          if (x + y > 50) {
            r = 30; g = 160; b = 220;
          }
          var a:int = transparent ? 255 - (x * 255) / (w - 1) : 255;
          bd.setPixel32(x, y, (a << 24) | (r << 16) | (g << 8) | b);
        }
      }

      return bd;
    }

    // The file's length and sum, its container and codestream headers, and the whole of it if asked.
    private static function file(name:String, bd:BitmapData, options:JPEGXREncoderOptions, whole:Boolean = false, rect:Rectangle = null):void {
      var f:ByteArray = bd.encode(rect || bd.rect, options);
      trace(name, f.length, sum(f, 0, f.length), whole ? hex(f, 0, f.length) : hex(f, 0, 122));
    }

    // Fletcher's sum of the bytes, which their order changes too.
    private static function sum(b:ByteArray, from:int, to:int):String {
      var s1:uint = 1;
      var s2:uint = 0;
      for (var i:int = from; i < to; i++) {
        s1 = (s1 + b[i]) % 65521;
        s2 = (s2 + s1) % 65521;
      }

      return (((s2 << 16) | s1) >>> 0).toString(16);
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
      for (var i:int = from; i < from + count && i < b.length; i++) {
        var s:String = b[i].toString(16);
        out += s.length < 2 ? "0" + s : s;
      }

      return out;
    }
  }
}
