package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.CubeTexture;
  import flash.display3D.textures.Texture;
  import flash.display3D.textures.TextureBase;
  import flash.events.ErrorEvent;
  import flash.events.Event;
  import flash.utils.ByteArray;

  // ATF textures uploaded by uploadCompressedTextureFromByteArray: each
  // format drawn, in both headers, and AIR's refusals of bad bytes, sync and
  // async. fixtures.ts replaces each ATF_ name with the base64 of
  // tests/context3d/atf's file of that name, OLD_ ones with the old header.
  public class AtfTextures extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;
    private var vertex:ByteArray;
    private var frames:int = 0;
    private var events:Array = [];
    private var pending:int = 0;
    private var later:Array = [];

    public function AtfTextures() {
      if (stage) { start(); }
      else { addEventListener(Event.ADDED_TO_STAGE, start); }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        context = slot.context3D;
        context.enableErrorChecking = true;
        context.configureBackBuffer(64, 64, 0, false);
        vertices = context.createVertexBuffer(4, 6);
        vertices.uploadFromVector(Vector.<Number>([
          -1, 1, 0.5, 1, 0, 0, 1, 1, 0.5, 1, 1, 0,
          -1, -1, 0.5, 1, 0, 1, 1, -1, 0.5, 1, 1, 1
        ]), 0, 4);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 2, 1, 3]), 0, 6);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        context.setVertexBufferAt(1, vertices, 4, "float2");
        context.setCulling("none");
        pixels = new BitmapData(64, 64, true, 0);
        vertex = header(false);
        emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
        emit(vertex, 0, 0x040f0000, 0xe4000001, 0);
        creation();
        formats();
        refusals();
        others();
        addEventListener(Event.ENTER_FRAME, finish);
      });
      slot.requestContext3D("auto", "baseline");
    }

    private static const CHARS:String = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    private function atf(text:String):ByteArray {
      var out:ByteArray = new ByteArray();
      var bits:int = 0, value:int = 0;
      for (var i:int = 0; i < text.length; i++) {
        var c:int = CHARS.indexOf(text.charAt(i));
        if (c < 0) { continue; }
        value = (value << 6) | c; bits += 6;
        if (bits >= 8) { bits -= 8; out.writeByte((value >> bits) & 255); }
      }
      out.position = 0;
      return out;
    }

    private function copy(data:ByteArray):ByteArray {
      var out:ByteArray = new ByteArray();
      out.writeBytes(data);
      out.position = 0;
      return out;
    }

    private function header(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0);
      bytes.writeUnsignedInt(1);
      bytes.writeByte(0xa1);
      bytes.writeByte(fragment ? 1 : 0);
      return bytes;
    }

    private function emit(bytes:ByteArray, op:uint, dest:uint, a:uint, at:uint, b:uint = 0, bt:uint = 0):void {
      bytes.writeUnsignedInt(op);
      bytes.writeUnsignedInt(dest);
      bytes.writeUnsignedInt(a);
      bytes.writeUnsignedInt(at);
      bytes.writeUnsignedInt(b);
      bytes.writeUnsignedInt(bt);
    }

    // The texture drawn over the back buffer, nearest, its sampler reading
    // `format` (0 RGBA, 1 DXT1, 2 DXT5), and the pixels at `points` traced.
    private function draw(label:String, texture:TextureBase, format:int, points:Array, mip:int = 0, face:int = -1):void {
      var fragment:ByteArray = header(true);
      if (face < 0) {
        emit(fragment, 0x28, 0x020f0000, 0xe4000000, 4, 0, 5 | (format << 8) | (mip << 24));
      } else {
        var direction:Array = [[1,0,0,1], [-1,0,0,1], [0,1,0,1], [0,-1,0,1], [0,0,1,1], [0,0,-1,1]][face];
        context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>(direction));
        emit(fragment, 0x28, 0x020f0000, 0xe4000000, 1, 0, 0x1005 | (format << 8) | (mip << 24));
      }
      emit(fragment, 0, 0x030f0000, 0xe4000000, 2);
      var program:Program3D = context.createProgram();
      program.upload(vertex, fragment);
      context.setProgram(program);
      context.setTextureAt(0, texture);
      context.clear(0.5, 0.5, 0.5, 1);
      try {
        context.drawTriangles(indices);
        context.drawToBitmapData(pixels);
        var out:Array = [];
        for (var i:int = 0; i < points.length; i += 2) {
          out.push(pixels.getPixel32(points[i], points[i + 1]).toString(16));
        }
        trace("atftextures", label, out.join(" "));
      } catch (error:Error) {
        trace("atftextures", label, error.name, error.errorID);
      }
      context.setTextureAt(0, null);
      program.dispose();
    }

    private static const QUADRANTS:Array = [16, 16, 48, 16, 16, 48, 48, 48];

    private function probe(label:String, action:Function):void {
      try { action(); trace("atftextures", label, "accepted"); }
      catch (error:Error) { trace("atftextures", label, error.name, error.errorID); }
    }

    private function make(cube:Boolean, size:int, format:String, height:int = 0):TextureBase {
      return cube ? context.createCubeTexture(size, format, false)
        : context.createTexture(size, height || size, format, false);
    }

    private function upload(texture:TextureBase, data:ByteArray, offset:uint = 0, async:Boolean = false):void {
      if (texture is CubeTexture) { CubeTexture(texture).uploadCompressedTextureFromByteArray(data, offset, async); }
      else { Texture(texture).uploadCompressedTextureFromByteArray(data, offset, async); }
    }

    private function creation():void {
      for each (var size:Array in [[1, 1], [2, 2], [4, 2], [2, 4], [1, 4], [4, 4], [8, 4]]) {
        var w:int = size[0], h:int = size[1];
        probe("create-" + w + "x" + h, function():void { context.createTexture(w, h, "compressed", false).dispose(); });
        probe("create-alpha-" + w + "x" + h, function():void { context.createTexture(w, h, "compressedAlpha", false).dispose(); });
      }
      probe("create-cube-2", function():void { context.createCubeTexture(2, "compressed", false).dispose(); });
      probe("create-cube-4", function():void { context.createCubeTexture(4, "compressedAlpha", false).dispose(); });
      probe("create-rectangle", function():void { context.createRectangleTexture(64, 64, "compressed", false).dispose(); });
      probe("create-rectangle-alpha", function():void { context.createRectangleTexture(64, 64, "compressedAlpha", false).dispose(); });
      probe("create-npot", function():void { context.createTexture(48, 48, "compressed", false).dispose(); });
      probe("create-npot-bgra", function():void { context.createTexture(48, 48, "bgra", false).dispose(); });
      // DXT1 is an eighth of BGRA's charge: more 2048s than BGRA's 21 fit.
      var held:Array = [];
      probe("budget-22", function():void {
        for (var i:int = 0; i < 22; i++) { held.push(context.createTexture(2048, 2048, "compressed", false)); }
      });
      for each (var t:Texture in held) { t.dispose(); }
    }

    private function good(label:String, cube:Boolean, size:int, format:String, data:ByteArray, read:int, height:int = 0, points:Array = null):void {
      var texture:TextureBase = make(cube, size, format, height);
      probe(label + "-upload", function():void { upload(texture, data); });
      if (cube) {
        for (var f:int = 0; f < 6; f++) { draw(label + "-side" + f, texture, read, [32, 32], 0, f); }
      } else {
        draw(label, texture, read, points || QUADRANTS);
      }
      texture.dispose();
    }

    private function formats():void {
      good("compressed", false, 64, "compressed", atf("ATF_compressed"), 1);
      good("raw", false, 64, "compressed", atf("ATF_raw"), 1);
      // A gradient's interpolated DXT colours are the GPU's own rounding: drawn, not read.
      good("wide", false, 64, "compressed", atf("ATF_compressed-wide"), 1, 32, []);
      good("compressed-alpha", false, 32, "compressedAlpha", atf("ATF_compressed-alpha"), 2);
      good("raw-alpha", false, 32, "compressedAlpha", atf("ATF_raw-alpha"), 2);
      good("rgb", false, 64, "bgra", atf("ATF_rgb"), 0);
      good("rgba", false, 32, "bgra", atf("ATF_rgba"), 0);
      good("rgb-cube", true, 16, "bgra", atf("ATF_rgb-cube"), 0);
      good("compressed-cube", true, 16, "compressed", atf("ATF_compressed-cube"), 1);
      good("old-compressed", false, 64, "compressed", atf("OLD_compressed"), 1);
      good("old-raw", false, 64, "compressed", atf("OLD_raw"), 1);
      good("old-compressed-alpha", false, 32, "compressedAlpha", atf("OLD_compressed-alpha"), 2);
      good("old-rgb", false, 64, "bgra", atf("OLD_rgb"), 0);
      good("old-compressed-cube", true, 16, "compressed", atf("OLD_compressed-cube"), 1);
      good("lossy", false, 64, "compressed", atf("ATF_compressed-lossy"), 1);
      // Its lossy alpha endpoints interpolate by the GPU's own rounding: drawn, not read.
      good("lossy-alpha", false, 32, "compressedAlpha", atf("ATF_compressed-lossy-alpha"), 2, 0, []);
      good("old-lossy", false, 64, "compressed", atf("OLD_compressed-lossy"), 1);
      good("old-lossy-alpha", false, 32, "compressedAlpha", atf("OLD_compressed-lossy-alpha"), 2);

      // Samplers must read what the texture is.
      good("compressed-read-rgba", false, 64, "compressed", atf("ATF_compressed"), 0);
      good("compressed-read-dxt5", false, 64, "compressed", atf("ATF_compressed"), 2);
      good("alpha-read-dxt1", false, 32, "compressedAlpha", atf("ATF_compressed-alpha"), 1);
      good("rgb-read-dxt1", false, 64, "bgra", atf("ATF_rgb"), 1);

      // Mips: every level, or only the levels 0 to 2 (#3700 with mipmapping).
      var texture:Texture = context.createTexture(64, 64, "compressed", false);
      texture.uploadCompressedTextureFromByteArray(atf("ATF_compressed"), 0);
      draw("mips", texture, 1, QUADRANTS, 1);
      texture.uploadCompressedTextureFromByteArray(atf("ATF_compressed-range"), 0);
      draw("range-replaces", texture, 1, QUADRANTS, 1);
      texture.dispose();
      texture = context.createTexture(64, 64, "compressed", false);
      texture.uploadCompressedTextureFromByteArray(atf("ATF_compressed-range"), 0);
      draw("range", texture, 1, QUADRANTS);
      draw("range-mips", texture, 1, QUADRANTS, 1);
      texture.dispose();

      // DXT1's three-colour blocks: blue, red, and transparent black for the fourth index.
      var three:ByteArray = raw(3, [0x1f, 0x00, 0x00, 0xf8, 0xc4, 0xff, 0xff, 0xff]);
      texture = context.createTexture(4, 4, "compressed", false);
      texture.uploadCompressedTextureFromByteArray(three, 0);
      draw("three-colours", texture, 1, [8, 8, 24, 8, 56, 8, 8, 40]);
      texture.dispose();
    }

    // A raw ATF of one 4x4 level: its DXT block, and empty PVRTC, ETC1 and ETC2 ones.
    private function raw(format:int, block:Array):ByteArray {
      var b:ByteArray = new ByteArray();
      b.writeUTFBytes("ATF");
      b.writeByte(0); b.writeByte(0); b.writeByte(0); b.writeByte(0xff); b.writeByte(3);
      b.writeUnsignedInt(4 + 4 + block.length + 12);
      b.writeByte(format); b.writeByte(2); b.writeByte(2); b.writeByte(1);
      b.writeUnsignedInt(block.length);
      for each (var v:int in block) { b.writeByte(v); }
      b.writeUnsignedInt(0); b.writeUnsignedInt(0); b.writeUnsignedInt(0);
      b.position = 0;
      return b;
    }

    private function bad(label:String, cube:Boolean, size:int, format:String, data:ByteArray, offset:uint = 0):void {
      var texture:TextureBase = make(cube, size, format);
      probe(label, function():void { upload(texture, data, offset); });
      texture.dispose();
    }

    private function refusals():void {
      var compressed:ByteArray = atf("ATF_compressed");
      var changed:Function = function(at:int, value:int, from:ByteArray = null):ByteArray {
        var out:ByteArray = copy(from || compressed);
        out[at] = value;
        return out;
      };
      bad("null", false, 64, "compressed", null);
      bad("empty", false, 64, "compressed", new ByteArray());
      var short:ByteArray = copy(compressed); short.length = 12;
      bad("short-header", false, 64, "compressed", short);
      var half:ByteArray = copy(compressed); half.length = compressed.length >> 1;
      bad("half", false, 64, "compressed", half);
      bad("offset-past", false, 64, "compressed", compressed, compressed.length + 4);
      bad("signature", false, 64, "compressed", changed(0, 0x42));
      var signatureShort:ByteArray = changed(0, 0x42); signatureShort.length = 100;
      bad("signature-and-short", false, 64, "compressed", signatureShort);
      bad("length-past", false, 64, "compressed", changed(8, 0x7f));
      bad("length-small", false, 64, "compressed", changed(11, 0x10));
      for each (var count:int in [0, 1, 8, 13, 20]) {
        bad("count" + count, false, 64, "compressed", changed(15, count));
      }
      bad("count20-bgra", false, 64, "bgra", changed(15, 20));
      bad("count20-size", false, 32, "compressed", changed(15, 20));
      bad("log13", false, 64, "compressed", changed(13, 13));
      for each (var format:int in [3, 6, 7, 11, 12, 13, 14, 0x7f]) {
        bad("format" + format, false, 64, "compressed", changed(12, format));
      }
      bad("format6-bgra", false, 64, "bgra", changed(12, 6));
      bad("format14-bgra", false, 64, "bgra", changed(12, 14));
      for each (var version:int in [0, 2, 4]) {
        bad("version" + version, false, 64, "compressed", changed(7, version));
      }
      bad("reserved", false, 64, "compressed", changed(3, 1));
      var trailing:ByteArray = copy(compressed); trailing.position = trailing.length; trailing.writeUnsignedInt(0xdeadbeef);
      bad("trailing", false, 64, "compressed", trailing);
      var shifted:ByteArray = new ByteArray(); shifted.writeByte(1); shifted.writeByte(2); shifted.writeBytes(compressed);
      bad("offset-2", false, 64, "compressed", shifted, 2);
      bad("offset-0-shifted", false, 64, "compressed", shifted);
      bad("bgra-compressed", false, 64, "bgra", compressed);
      bad("compressed-rgb", false, 64, "compressed", atf("ATF_rgb"));
      bad("compressed-alpha", false, 32, "compressed", atf("ATF_compressed-alpha"));
      bad("alpha-compressed", false, 64, "compressedAlpha", compressed);
      bad("size-small", false, 32, "compressed", compressed);
      bad("size-large", false, 128, "compressed", compressed);
      bad("size-and-format", false, 32, "bgra", compressed);
      bad("cube-2d", true, 64, "compressed", compressed);
      bad("2d-cube", false, 16, "compressed", atf("ATF_compressed-cube"));
      var lzma:ByteArray = copy(compressed);
      for (var i:int = 25; i < 60; i++) { lzma[i] = 0xff; }
      bad("corrupt-lzma", false, 64, "compressed", lzma);
      bad("corrupt-lzma-size", false, 32, "compressed", lzma);
      var length:uint = (compressed[16] << 24) | (compressed[17] << 16) | (compressed[18] << 8) | compressed[19];
      var jxr:ByteArray = copy(compressed);
      for (i = 20 + length + 4 + 40; i < 20 + length + 4 + 90; i++) { jxr[i] = 0x5a; }
      bad("corrupt-jxr", false, 64, "compressed", jxr);
      var rgb:ByteArray = atf("ATF_rgb");
      for (i = 60; i < 140; i++) { rgb[i] = 0x5a; }
      bad("corrupt-rgb", false, 64, "bgra", rgb);
      var blocks:ByteArray = copy(compressed); blocks[16] = blocks[17] = blocks[18] = blocks[19] = 0;
      bad("block-past", false, 64, "compressed", blocks);

      // AIR reads as far as the data goes, the length aside: a short length
      // with the data whole changes nothing; data cut at a level, or in its
      // first block's length, keeps the levels before it; data cut in a
      // block the desktop reads is corrupt.
      var levelEnd:Function = function(levels:int):uint {
        var at:uint = 16;
        for (var l:int = 0; l < levels; l++) {
          for (var b:int = 0; b < 11; b++) {
            at += 4 + ((compressed[at] << 24) | (compressed[at + 1] << 16) | (compressed[at + 2] << 8) | compressed[at + 3]);
          }
        }
        return at;
      };
      var cuts:Array = [["whole-length16", compressed.length, 16], ["whole-length-level1", compressed.length, levelEnd(1)],
        ["cut-level2", levelEnd(2), levelEnd(2)], ["cut-in-field", levelEnd(1) + 2, levelEnd(1) + 2],
        ["cut-in-dxt", levelEnd(1) + 10, levelEnd(1) + 10], ["cut-in-etc", compressed.length >> 1, 16]];
      for each (var cut:Array in cuts) {
        var data:ByteArray = copy(compressed);
        data.length = cut[1];
        var n:uint = cut[2] - 12;
        data[8] = n >>> 24; data[9] = (n >>> 16) & 255; data[10] = (n >>> 8) & 255; data[11] = n & 255;
        var streamed:Texture = context.createTexture(64, 64, "compressed", false);
        probe(cut[0], function():void { streamed.uploadCompressedTextureFromByteArray(data, 0); });
        draw(cut[0], streamed, 1, QUADRANTS);
        draw(cut[0] + "-mips", streamed, 1, QUADRANTS, 1);
        streamed.dispose();
      }

      // A length that ends early: the levels before it, or none.
      var texture:Texture = context.createTexture(64, 64, "compressed", false);
      var alone:ByteArray = copy(compressed); alone.length = 16; alone[8] = alone[9] = alone[10] = alone[11] = 0;
      probe("header-alone", function():void { texture.uploadCompressedTextureFromByteArray(alone, 0); });
      draw("header-alone", texture, 1, QUADRANTS);
      texture.dispose();
    }

    private function others():void {
      var texture:Texture = context.createTexture(64, 64, "compressed", true);
      probe("render-to-compressed", function():void { context.setRenderToTexture(texture); });
      probe("render-to-compressed-clear", function():void { context.clear(0, 1, 0, 1); });
      probe("render-to-compressed-draw", function():void { context.drawTriangles(indices); });
      context.setRenderToBackBuffer();
      texture.uploadFromBitmapData(new BitmapData(64, 64, false, 0xff0000));
      draw("bitmap-on-compressed", texture, 1, QUADRANTS);
      texture.uploadCompressedTextureFromByteArray(atf("ATF_compressed"), 0);
      draw("atf-after-bitmap", texture, 1, QUADRANTS);
      texture.uploadFromBitmapData(new BitmapData(64, 64, false, 0x00ff00));
      draw("bitmap-after-atf", texture, 1, QUADRANTS);
      texture.dispose();
      texture = context.createTexture(64, 64, "bgra", false);
      texture.uploadCompressedTextureFromByteArray(atf("ATF_rgb"), 0);
      draw("bgra-atf", texture, 0, QUADRANTS);
      texture.dispose();
    }

    private function asynchronous():void {
      var compressed:ByteArray = atf("ATF_compressed");
      var lzma:ByteArray = copy(compressed);
      for (var i:int = 25; i < 60; i++) { lzma[i] = 0xff; }
      var signature:ByteArray = copy(compressed); signature[0] = 0;
      var half:ByteArray = copy(compressed); half.length = compressed.length >> 1;
      var changing:ByteArray = copy(compressed);
      later.push(queue("ready", 64, "compressed", compressed));
      queue("corrupt", 64, "compressed", lzma);
      queue("mismatch", 64, "compressed", atf("ATF_rgb"));
      queue("size", 32, "compressed", compressed);
      queue("signature", 64, "compressed", signature);
      queue("short", 64, "compressed", half);
      // The bytes are read when it is called.
      later.push(queue("changed", 64, "compressed", changing));
      for (i = 16; i < changing.length; i++) { changing[i] = 0; }
      // Disposed before it is ready, it hears #3677.
      var disposed:Texture = Texture(queue("disposed", 64, "compressed", compressed));
      disposed.dispose();
      draw("async-before", later[0], 1, QUADRANTS);
    }

    private function queue(label:String, size:int, format:String, data:ByteArray):TextureBase {
      var texture:Texture = context.createTexture(size, size, format, false);
      // Frames counted since the uploads, which an enterFrame made: AIR delivers before the next.
      texture.addEventListener(Event.TEXTURE_READY, function(event:Event):void {
        events.push(label + " " + event.type + " " + (event.target == texture) + " " + (frames - 1));
        pending--;
      });
      texture.addEventListener(ErrorEvent.ERROR, function(event:ErrorEvent):void {
        events.push(label + " " + event.type + " " + event.errorID + " " + event.text + " " + (frames - 1));
        pending--;
      });
      try {
        texture.uploadCompressedTextureFromByteArray(data, 0, true);
        pending++;
        trace("atftextures async", label, "returned");
      } catch (error:Error) {
        trace("atftextures async", label, error.name, error.errorID);
      }
      return texture;
    }

    private function finish(event:Event):void {
      frames++;
      if (frames == 1) {
        asynchronous();
        return;
      }
      if (pending > 0 || complete) {
        return;
      }

      for each (var line:String in events) { trace("atftextures event", line); }
      draw("async-ready", later[0], 1, QUADRANTS);
      draw("async-changed", later[1], 1, QUADRANTS);
      context.dispose(false);
      complete = true;
      trace("atftextures complete");
    }
  }
}
