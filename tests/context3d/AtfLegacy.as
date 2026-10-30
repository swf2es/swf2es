package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.Texture;
  import flash.display3D.textures.TextureBase;
  import flash.events.Event;
  import flash.utils.ByteArray;

  // AtfTextures for content before SWF 17, which AIR serves as Flash Player
  // 11.0 to 11.3 did: compiled as SWF 13. fixtures.ts replaces each ATF_ name with the base64 of
  // tests/context3d/atf's file of that name, OLD_ ones with the old header.
  public class AtfLegacy extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;
    private var vertex:ByteArray;

    public function AtfLegacy() {
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
        formats();
      });
      slot.requestContext3D("auto");
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
        trace("atflegacy", label, out.join(" "));
      } catch (error:Error) {
        trace("atflegacy", label, error.name, error.errorID);
      }
      context.setTextureAt(0, null);
      program.dispose();
    }

    private static const QUADRANTS:Array = [16, 16, 48, 16, 16, 48, 48, 48];

    private function probe(label:String, action:Function):void {
      try { action(); trace("atflegacy", label, "accepted"); }
      catch (error:Error) { trace("atflegacy", label, error.name, error.errorID); }
    }

    private function formats():void {
      // Before SWF 17, AIR reads the old header alone, and no CompressedAlpha.
      var texture:Texture = context.createTexture(64, 64, "compressed", false);
      probe("old-compressed", function():void { texture.uploadCompressedTextureFromByteArray(atf("OLD_compressed"), 0); });
      // and samplers read a compressed texture whatever their format.
      draw("read-rgba", texture, 0, QUADRANTS);
      draw("read-dxt1", texture, 1, QUADRANTS);
      draw("read-dxt5", texture, 2, QUADRANTS);
      probe("new-compressed", function():void { texture.uploadCompressedTextureFromByteArray(atf("ATF_compressed"), 0); });
      texture.dispose();
      var alpha:Texture = context.createTexture(32, 32, "compressedAlpha", false);
      probe("old-compressed-alpha", function():void { alpha.uploadCompressedTextureFromByteArray(atf("OLD_compressed-alpha"), 0); });
      probe("old-raw-alpha", function():void { alpha.uploadCompressedTextureFromByteArray(atf("OLD_raw-alpha"), 0); });
      alpha.dispose();
      var bgra:Texture = context.createTexture(64, 64, "bgra", false);
      probe("old-rgb", function():void { bgra.uploadCompressedTextureFromByteArray(atf("OLD_rgb"), 0); });
      draw("old-rgb", bgra, 1, QUADRANTS);
      probe("new-rgb", function():void { bgra.uploadCompressedTextureFromByteArray(atf("ATF_rgb"), 0); });
      bgra.dispose();
      complete = true;
      trace("atflegacy complete");
    }
  }
}
