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

  public class Mipmaps extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var texture:Texture;
    private var second:Texture;
    private var pixels:BitmapData;
    private var vertex:ByteArray;

    public function Mipmaps() {
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
        trace("mipmaps complete");
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
        trace("mipmaps", label, pixels.getPixel32(16, 16).toString(16), pixels.getPixel32(48, 48).toString(16));
      } catch (error:Error) { trace("mipmaps", label, error.name, error.errorID); }
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
      draw("unuploaded", 0x01000000, 8);
      upload(0, 0xffff0000);
      draw("base-only-no-mip", 0, 8);
      draw("base-only-mip", 0x01000000, 8);
      upload(1, 0xff00ff00);
      draw("partial-mip", 0x01000000, 8);
      upload(2, 0xff0000ff);
      upload(3, 0xffffff00);
      upload(4, 0xff00ffff);
      for (var filter:int = 0; filter < 2; filter++) {
        for (var mip:int = 0; mip < 3; mip++) {
          for (var lod:int = 0; lod < 6; lod++) {
            draw("f" + filter + "m" + mip + "l" + lod, (filter << 28) | (mip << 24), 4 * Math.pow(2, lod));
          }
        }
      }
      draw("interpolate", 0x12000000, 4 * Math.sqrt(2));
      upload(1, 0xffff00ff);
      draw("reupload", 0x11000000, 8);
      var one:BitmapData = new BitmapData(1, 1, true, 0xffffffff);
      try { texture.uploadFromBitmapData(one, 5); trace("mipmaps level-outside accepted"); }
      catch (error:Error) { trace("mipmaps level-outside", error.name, error.errorID); }
      one.dispose();
      context.present();
      draw("present", 0x12000000, 8);
    }
  }
}
