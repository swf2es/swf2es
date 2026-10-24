package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.Texture;
  import flash.display3D.textures.CubeTexture;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class CubeBitmapUploads extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var texture:CubeTexture;
    private var pixels:BitmapData;
    private var vertex:ByteArray;

    public function CubeBitmapUploads() {
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
        emit(vertex, 3, 0x030f0000, 0xe4000000, 0, 0xe4000003, 1);
        emit(vertex, 0, 0x040f0000, 0xe4000001, 0);
        run();
        vertices.dispose(); indices.dispose(); pixels.dispose(); texture.dispose();
        context.dispose(false);
        complete = true;
        trace("cubebitmapuploads complete");
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

    private function draw(label:String, face:int, level:int):void {
      var fragment:ByteArray = header(true);
      // Map the interpolated face coordinates to a cube direction.
      emit(fragment, 3, 0x020f0000, 0x00000000, 4, 0xe4000000, 1);
      emit(fragment, 3, 0x020f0001, 0x55000000, 4, 0xe4000001, 1);
      emit(fragment, 1, 0x020f0000, 0xe4000000, 2, 0xe4000001, 2);
      emit(fragment, 1, 0x020f0000, 0xe4000000, 2, 0xe4000002, 1);
      emit(fragment, 0x28, 0x030f0000, 0xe4000000, 2, ((level + 2) * 8) << 16, 0x01001005);
      var program:Program3D = context.createProgram();
      program.upload(vertex, fragment);
      context.setProgram(program);
      var axes:Array = [
        [0,0,-2,0, 0,-2,0,0, 1,1,1,0],
        [0,0,2,0, 0,-2,0,0, -1,1,-1,0],
        [2,0,0,0, 0,0,2,0, -1,1,-1,0],
        [2,0,0,0, 0,0,-2,0, -1,-1,1,0],
        [2,0,0,0, 0,-2,0,0, -1,1,1,0],
        [-2,0,0,0, 0,-2,0,0, 1,1,-1,0]
      ];
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>(axes[face]));
      context.setProgramConstantsFromVector("vertex", 3, Vector.<Number>([1, 1, 1, 1]));
      context.clear(0, 0, 0, 1);
      try {
        context.drawTriangles(indices);
        context.drawToBitmapData(pixels);
        trace("cubebitmapuploads", label, pixels.getPixel32(16,16).toString(16),
          pixels.getPixel32(48,16).toString(16), pixels.getPixel32(16,48).toString(16),
          pixels.getPixel32(48,48).toString(16), pixels.getPixel32(32,32).toString(16));
      } catch (error:Error) { trace("cubebitmapuploads", label, error.name, error.errorID); }
      program.dispose();
    }

    private function upload(face:uint, level:uint):void {
      var colors:Array = [0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffff00, 0xff00ffff, 0xffff00ff];
      var size:int = Math.max(1, 16 >> level);
      var bitmap:BitmapData = new BitmapData(size, size, true, colors[face]);
      if (level === 0) {
        for (var y:int = 0; y < size; y++) {
          for (var x:int = 0; x < size; x++) {
            bitmap.setPixel32(x, y, uint(colors[face]) & (x < 8 ? (y < 8 ? 0xff333333 : 0xff999999) : (y < 8 ? 0xff666666 : 0xffffffff)));
          }
        }
      } else {
        bitmap.fillRect(bitmap.rect, [0,0xff333333,0xff666666,0xff999999,0xffcccccc][level]);
      }
      texture.uploadFromBitmapData(bitmap, face, level);
      bitmap.dispose();
    }

    private function run():void {
      texture = context.createCubeTexture(16, "bgra", false);
      context.setTextureAt(0, texture);
      var cases:Array = [
        ["same", 16, 16, 0], ["large", 32, 21, 0], ["small", 7, 9, 0],
        ["wider-mip1", 19, 5, 1], ["taller-mip1", 3, 23, 1],
        ["large-mip2", 19, 11, 2], ["small-mip2", 3, 1, 2], ["mip4", 3, 5, 4]
      ];
      for (var face:int = 0; face < 6; face++) {
        for (var i:int = 0; i < cases.length; i++) {
          for (var seedFace:int = 0; seedFace < 6; seedFace++) {
            for (var level:int = 0; level < 5; level++) { upload(seedFace, level); }
          }
          var entry:Array = cases[i];
          var label:String = entry[0] + "-face" + face;
          var source:BitmapData = new BitmapData(entry[1], entry[2], true, 0);
          for (var y:int = 0; y < source.height; y++) {
            for (var x:int = 0; x < source.width; x++) {
              source.setPixel32(x, y, 0xff000000 | ((x * 17 & 255) << 16) | ((y * 33 & 255) << 8) | ((x + y) * 11 & 255));
            }
          }
          try {
            texture.uploadFromBitmapData(source, face, entry[3]);
            trace("cubebitmapuploads", label, "accepted");
          } catch (error:Error) { trace("cubebitmapuploads", label, error.name, error.errorID); }
          source.dispose();
          draw(label, face, entry[3]);
          draw("neighbor-" + label, (face + 1) % 6, entry[3]);
        }
      }
      context.present();
    }
  }
}
