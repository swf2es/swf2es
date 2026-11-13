package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.TextureBase;
  import flash.events.Event;
  import flash.utils.ByteArray;

  // The packed and half-float formats: what their bitmap and byte uploads store, what a
  // sampler reads of them, and what drawing into them keeps.
  public class TextureFormats extends Sprite {
    public var complete:Boolean = false;
    private static const VERBOSE:Boolean = false;
    private var c:Context3D;
    private var quad:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;
    private var plain:Program3D;
    private var cube:Program3D;

    public function TextureFormats() {
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        c = slot.context3D;
        c.enableErrorChecking = true;
        c.configureBackBuffer(64, 64, 0, false);
        quad = c.createVertexBuffer(4, 4);
        quad.uploadFromVector(Vector.<Number>([-1, 1, 0, 0, 1, 1, 1, 0, 1, -1, 1, 1, -1, -1, 0, 1]), 0, 4);
        indices = c.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 0, 2, 3]), 0, 6);
        c.setVertexBufferAt(0, quad, 0, "float2");
        c.setVertexBufferAt(1, quad, 2, "float2");
        pixels = new BitmapData(64, 64, true, 0);
        plain = program(0x00000005);
        cube = program(0x00001005);
        run();
        c.dispose(false);
        complete = true;
        trace("textureformats complete");
      });
      slot.requestContext3D("auto", "standard");
    }

    private function agal(fragment:Boolean, rows:Array):ByteArray {
      var b:ByteArray = new ByteArray();
      b.endian = "littleEndian";
      b.writeByte(0xa0);
      b.writeUnsignedInt(1);
      b.writeByte(0xa1);
      b.writeByte(fragment ? 1 : 0);
      for (var i:int = 0; i < rows.length; i++) {
        for (var j:int = 0; j < 6; j++) {
          b.writeUnsignedInt(rows[i][j]);
        }
      }
      return b;
    }

    // The texture at fs0 over the back buffer, times fc0; a cube one along fc1 + uv * fc2.
    private function program(sampler:uint):Program3D {
      var p:Program3D = c.createProgram();
      var read:Array = sampler & 0x1000
        ? [[3, 0x020f0000, 0xc6000000, 4, 0xe4000002, 1], [1, 0x020f0000, 0xe4000000, 2, 0xe4000001, 1],
           [0x28, 0x020f0000, 0xe4000000, 2, 0, sampler]]
        : [[0x28, 0x020f0000, 0xe4000000, 4, 0, sampler]];
      read.push([3, 0x030f0000, 0xe4000000, 2, 0xe4000000, 1]);
      p.upload(agal(false, [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x040f0000, 0xe4000001, 0, 0, 0]]),
        agal(true, read));
      return p;
    }

    private function test(label:String, f:Function):void {
      try {
        f();
        trace("textureformats", label, "accepted");
      } catch (e:Error) {
        trace("textureformats", label, e.name, e.errorID);
        if (VERBOSE) { trace("message", e.message); }
      }
    }

    private function show(label:String, texture:TextureBase, scale:Number = 1, isCube:Boolean = false):void {
      try {
        c.setRenderToBackBuffer();
        c.setProgram(isCube ? cube : plain);
        c.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([scale, scale, scale, scale]));
        c.setProgramConstantsFromVector("fragment", 1, Vector.<Number>([1, -1, -1, 0]));
        c.setProgramConstantsFromVector("fragment", 2, Vector.<Number>([0, 2, 2, 0]));
        c.setTextureAt(0, texture);
        c.clear(0, 0, 1, 1);
        c.drawTriangles(indices);
        c.setTextureAt(0, null);
        c.drawToBitmapData(pixels);
        trace("textureformats", label, pixels.getPixel32(16, 16).toString(16), pixels.getPixel32(48, 16).toString(16),
          pixels.getPixel32(16, 48).toString(16), pixels.getPixel32(48, 48).toString(16));
      } catch (e:Error) {
        c.setTextureAt(0, null);
        trace("textureformats", label, e.name, e.errorID);
        if (VERBOSE) { trace("message", e.message); }
      }
    }

    private function words(values:Array, size:int):ByteArray {
      var b:ByteArray = new ByteArray();
      b.endian = "littleEndian";
      for (var i:int = 0; i < values.length; i++) {
        if (size == 2) { b.writeShort(values[i]); } else { b.writeUnsignedInt(values[i]); }
      }
      return b;
    }

    private function run():void {
      var source:BitmapData = new BitmapData(2, 2, true, 0);
      source.setPixel32(0, 0, 0xff123456);
      source.setPixel32(1, 0, 0xffedcba9);
      source.setPixel32(0, 1, 0x80ff8040);
      source.setPixel32(1, 1, 0xff7f8081);
      var format:String;
      for each (format in ["bgra", "bgrPacked565", "bgraPacked4444", "rgbaHalfFloat"]) {
        var t:* = c.createTexture(2, 2, format, false);
        test(format + "-bitmap", function():void { t.uploadFromBitmapData(source); });
        show(format + "-bitmap-drawn", t);
        var r:* = c.createRectangleTexture(2, 2, format, false);
        test(format + "-rectangle-bitmap", function():void { r.uploadFromBitmapData(source); });
        show(format + "-rectangle-drawn", r);
        r.dispose();
        t.dispose();
      }

      // One channel at a time, each texel its own, through the bytes.
      var packed:ByteArray = words([0xf800, 0x07e0, 0x001f, 0x8410], 2);
      var t565:* = c.createTexture(2, 2, "bgrPacked565", false);
      for each (var length:int in [7, 8, 16]) {
        var cut:ByteArray = new ByteArray();
        cut.writeBytes(packed.length >= length ? packed : words([0xf800, 0x07e0, 0x001f, 0x8410, 0, 0, 0, 0], 2), 0, length);
        test("bgrPacked565-bytes-" + length, function():void { t565.uploadFromByteArray(cut, 0); });
      }
      t565.uploadFromByteArray(packed, 0);
      show("bgrPacked565-bytes-drawn", t565);
      test("bgrPacked565-bytes-offset", function():void { t565.uploadFromByteArray(words([0, 0x001f, 0xf800, 0x07e0, 0xffff], 2), 2); });
      show("bgrPacked565-offset-drawn", t565);

      var t4444:* = c.createTexture(2, 2, "bgraPacked4444", false);
      test("bgraPacked4444-bytes", function():void { t4444.uploadFromByteArray(words([0xf000, 0x0f00, 0x00f0, 0x000f], 2), 0); });
      show("bgraPacked4444-bytes-drawn", t4444);
      test("bgraPacked4444-bytes-mixed", function():void { t4444.uploadFromByteArray(words([0xf8f0, 0x8f0f, 0x1234, 0xfedc], 2), 0); });
      show("bgraPacked4444-mixed-drawn", t4444);

      // Half floats: 1, 0.5, 0.25, 2 and 0 in each channel.
      var half:ByteArray = words([0x3c00, 0x0000, 0x0000, 0x3c00, 0x0000, 0x3800, 0x0000, 0x3c00,
        0x0000, 0x0000, 0x3400, 0x3c00, 0x4000, 0x4000, 0x4000, 0x3800], 2);
      var tHalf:* = c.createTexture(2, 2, "rgbaHalfFloat", false);
      for each (length in [16, 31, 32]) {
        var part:ByteArray = new ByteArray();
        part.writeBytes(half, 0, length);
        test("rgbaHalfFloat-bytes-" + length, function():void { tHalf.uploadFromByteArray(part, 0); });
      }
      tHalf.uploadFromByteArray(half, 0);
      show("rgbaHalfFloat-bytes-drawn", tHalf);
      show("rgbaHalfFloat-bytes-scaled", tHalf, 0.25);

      // Drawing into each format, then reading it back through a sampler.
      for each (format in ["bgrPacked565", "bgraPacked4444", "rgbaHalfFloat"]) {
        var target:* = c.createTexture(2, 2, format, true);
        test(format + "-target-clear", function():void {
          c.setRenderToTexture(target);
          c.clear(0.3, 0.6, 0.9, 0.5);
        });
        show(format + "-cleared", target);
        test(format + "-target-bright", function():void {
          c.setRenderToTexture(target);
          c.clear(3, -1, 0.5, 2);
        });
        show(format + "-bright-scaled", target, 0.25);
        test(format + "-target-draw", function():void {
          c.setRenderToTexture(target);
          c.clear(0, 0, 0, 0);
          var bright:Program3D = c.createProgram();
          bright.upload(agal(false, [[0, 0x030f0000, 0xe4000000, 0, 0, 0]]), agal(true, [[0, 0x030f0000, 0xe4000000, 1, 0, 0]]));
          c.setProgram(bright);
          c.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([2.5, 0.75, -0.5, 4]));
          c.setVertexBufferAt(1, null);
          c.drawTriangles(indices);
          c.setVertexBufferAt(1, quad, 2, "float2");
          bright.dispose();
        });
        show(format + "-drawn-scaled", target, 0.25);
        target.dispose();
      }

      // Cube faces of each format, and their mips.
      for each (format in ["bgrPacked565", "bgraPacked4444", "rgbaHalfFloat"]) {
        var faces:* = c.createCubeTexture(2, format, false);
        test(format + "-cube-bitmap", function():void {
          for (var face:int = 0; face < 6; face++) {
            faces.uploadFromBitmapData(source, face, 0);
            var small:BitmapData = new BitmapData(1, 1, true, 0xff00ff00);
            faces.uploadFromBitmapData(small, face, 1);
          }
        });
        show(format + "-cube-drawn", faces, 1, true);
        faces.dispose();
        var mips:* = c.createTexture(4, 4, format, false);
        test(format + "-mip-bitmap", function():void {
          mips.uploadFromBitmapData(new BitmapData(4, 4, true, 0xffff0000), 0);
          mips.uploadFromBitmapData(new BitmapData(2, 2, true, 0xff00ff00), 1);
          mips.uploadFromBitmapData(new BitmapData(1, 1, true, 0xff0000ff), 2);
        });
        mips.dispose();
      }

      // A sampler that names another format for each.
      for each (format in ["bgrPacked565", "bgraPacked4444", "rgbaHalfFloat"]) {
        var named:* = c.createTexture(2, 2, format, false);
        named.uploadFromBitmapData(source);
        for each (var kind:int in [1, 2]) {
          var other:Program3D = program(0x00000005 | (kind << 8));
          try {
            c.setProgram(other);
            c.setTextureAt(0, named);
            c.clear(0, 0, 1, 1);
            c.drawTriangles(indices);
            trace("textureformats", format + "-sampler-" + kind, "accepted");
          } catch (e:Error) {
            trace("textureformats", format + "-sampler-" + kind, e.name, e.errorID);
          }
          c.setTextureAt(0, null);
          other.dispose();
        }
        named.dispose();
      }
      source.dispose();
    }
  }
}
