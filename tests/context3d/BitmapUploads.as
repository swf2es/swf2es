package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.Texture;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class BitmapUploads extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var texture:Texture;
    private var pixels:BitmapData;
    private var vertex:ByteArray;

    public function BitmapUploads() {
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
        run();
        vertices.dispose(); indices.dispose(); pixels.dispose(); texture.dispose();
        context.dispose(false);
        complete = true;
        trace("bitmapuploads complete");
      });
      slot.requestContext3D("auto", "baseline");
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

    private function draw(label:String, flags:uint, scale:Number = 1):void {
      var fragment:ByteArray = header(true);
      emit(fragment, 3, 0x020f0000, 0xe4000000, 4, 0xe4000000, 1);
      emit(fragment, 0x28, 0x030f0000, 0xe4000000, 2, 0, flags | 5);
      var program:Program3D = context.createProgram();
      program.upload(vertex, fragment);
      context.setProgram(program);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([scale, scale, 0, 1]));
      context.clear(0, 0, 0, 1);
      try {
        context.drawTriangles(indices);
        context.drawToBitmapData(pixels);
        trace("bitmapuploads", label, pixels.getPixel32(0, 0).toString(16), pixels.getPixel32(15, 15).toString(16), pixels.getPixel32(45, 45).toString(16));
      } catch (error:Error) { trace("bitmapuploads", label, error.name, error.errorID); }
      program.dispose();
    }

    private function upload(level:uint, color:uint):void {
      var bitmap:BitmapData = new BitmapData(Math.max(1, 16 >> level), Math.max(1, 8 >> level), true, color);
      texture.uploadFromBitmapData(bitmap, level);
      bitmap.dispose();
    }

    private function run():void {
      texture = context.createTexture(16, 8, "bgra", false);
      context.setTextureAt(0, texture);
      var cases:Array = [
        ["same", 16, 8, 0], ["large-base", 32, 16, 0],
        ["small-base", 8, 4, 0], ["wider", 32, 4, 0], ["taller", 8, 16, 0],
        ["nonpow2-large", 19, 11, 0], ["nonpow2-small", 11, 5, 0],
        ["large-mip1", 16, 8, 1], ["small-mip1", 4, 2, 1], ["large-mip4", 16, 8, 4]
      ];
      for (var i:int = 0; i < cases.length; i++) {
        for (var level:int = 0; level < 5; level++) { upload(level, 0xff112233); }
        var entry:Array = cases[i];
        var source:BitmapData = new BitmapData(entry[1], entry[2], true, 0);
        for (var y:int = 0; y < source.height; y++) {
          for (var x:int = 0; x < source.width; x++) {
            source.setPixel32(x, y, 0xff000000 | ((x * 17 & 255) << 16) | ((y * 33 & 255) << 8) | ((x + y) * 11 & 255));
          }
        }
        try {
          texture.uploadFromBitmapData(source, entry[3]);
          trace("bitmapuploads", entry[0], "accepted");
        } catch (error:Error) {
          trace("bitmapuploads", entry[0], error.name, error.errorID);
        }
        source.dispose();
        draw(entry[0], 0x01100000, 4 * Math.pow(2, entry[3]));
      }
      context.present();
    }
  }
}
