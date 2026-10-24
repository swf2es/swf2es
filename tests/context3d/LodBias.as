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

  public class LodBias extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var texture:Texture;
    private var cube:CubeTexture;
    private var pixels:BitmapData;
    private var vertex:ByteArray;

    public function LodBias() {
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
        vertices = context.createVertexBuffer(4, 7);
        vertices.uploadFromVector(Vector.<Number>([
          -1, 1, 0.5, 1, 0, 0, 1, 1, 1, 0.5, 1, 1, 0, 1,
          -1, -1, 0.5, 1, 0, 1, 1, 1, -1, 0.5, 1, 1, 1, 1
        ]), 0, 4);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 2, 1, 3]), 0, 6);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        context.setVertexBufferAt(1, vertices, 4, "float3");
        context.setCulling("none");
        pixels = new BitmapData(64, 64, true, 0);
        vertex = header(false);
        emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
        emit(vertex, 0, 0x040f0000, 0xe4000001, 0);
        run();
        context.setTextureAt(0, null);
        context.setTextureAt(1, null);
        vertices.dispose(); indices.dispose(); pixels.dispose(); texture.dispose(); cube.dispose();
        context.dispose(false);
        complete = true;
        trace("lodbias complete");
      });
      slot.requestContext3D("auto", "baseline");
    }

    private function header(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0); bytes.writeUnsignedInt(1);
      bytes.writeByte(0xa1); bytes.writeByte(fragment ? 1 : 0);
      return bytes;
    }

    private function emit(bytes:ByteArray, op:uint, dest:uint, a:uint, at:uint, b:uint = 0, bt:uint = 0):void {
      bytes.writeUnsignedInt(op); bytes.writeUnsignedInt(dest);
      bytes.writeUnsignedInt(a); bytes.writeUnsignedInt(at);
      bytes.writeUnsignedInt(b); bytes.writeUnsignedInt(bt);
    }

    private function shader(flags:uint, bias:int, secondBias:int = 1000, secondSlot:int = 0):ByteArray {
      var bytes:ByteArray = header(true);
      emit(bytes, 3, 0x020f0000, 0xe4000000, 4, 0xe4000000, 1);
      emit(bytes, 1, 0x020f0000, 0xe4000000, 2, 0xe4000001, 1);
      emit(bytes, 0x28, 0x020f0001, 0xe4000000, 2, (bias & 255) << 16, flags | 5);
      if (secondBias != 1000) {
        emit(bytes, 0x28, 0x020f0002, 0xe4000000, 2, ((secondBias & 255) << 16) | secondSlot, flags | 5);
        emit(bytes, 0, 0x02020001, 0xe4000002, 2);
      }
      emit(bytes, 0, 0x030f0000, 0xe4000001, 2);
      return bytes;
    }

    private function sample(label:String):void {
      context.clear(0, 0, 0, 1);
      context.drawTriangles(indices);
      context.drawToBitmapData(pixels);
      trace("lodbias", label, pixels.getPixel32(16, 16).toString(16),
        pixels.getPixel32(32, 32).toString(16), pixels.getPixel32(48, 48).toString(16));
    }

    private function draw(label:String, flags:uint, bias:int, scale:Number = 1,
      secondBias:int = 1000, secondSlot:int = 0, override:String = null):void {
      var program:Program3D = context.createProgram();
      var phase:String = "upload";
      try {
        program.upload(vertex, shader(flags, bias, secondBias, secondSlot));
        phase = "select";
        context.setProgram(program);
        context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([scale, scale, 1, 1]));
        var isCube:Boolean = (flags & 0x1000) != 0;
        context.setProgramConstantsFromVector("fragment", 1, Vector.<Number>([isCube ? -1 : 0, isCube ? -1 : 0, 0, 0]));
        if (override != null) { context.setSamplerStateAt(0, "clamp", "nearest", override); }
        phase = "draw";
        sample(label);
      } catch (error:Error) { trace("lodbias", label, phase, error.name, error.errorID); }
      program.dispose();
    }

    private function run():void {
      texture = context.createTexture(64, 32, "bgra", false);
      cube = context.createCubeTexture(64, "bgra", false);
      for (var level:int = 0; level < 7; level++) {
        var color:uint = 0xff000000 | ((32 + 24 * level) << 16) | ((192 - 24 * level) << 8) | (16 + 16 * level);
        var bitmap:BitmapData = new BitmapData(Math.max(1, 64 >> level), Math.max(1, 32 >> level), true, color);
        texture.uploadFromBitmapData(bitmap, level); bitmap.dispose();
        bitmap = new BitmapData(Math.max(1, 64 >> level), Math.max(1, 64 >> level), true, color);
        for (var face:int = 0; face < 6; face++) { cube.uploadFromBitmapData(bitmap, face, level); }
        bitmap.dispose();
      }
      context.setTextureAt(0, texture);
      for each (var bias:int in [-128, -32, -16, -9, -8, -7, -1, 0, 1, 7, 8, 9, 16, 24, 32, 64, 127]) {
        for (var mip:int = 0; mip < 3; mip++) {
          draw("flat-m" + mip + "b" + bias, mip << 24, bias, 4);
        }
      }
      draw("same-slot-equal", 0x01000000, 8, 4, 8);
      draw("same-slot", 0x01000000, 0, 4, 8);
      context.setTextureAt(1, texture);
      draw("two-slots-equal", 0x01000000, 8, 4, 8, 1);
      draw("two-slots", 0x01000000, 0, 4, 8, 1);
      context.setTextureAt(1, null);
      draw("override-none", 0x01000000, 8, 4, 1000, 0, "mipnone");
      draw("override-nearest", 0, 8, 4, 1000, 0, "mipnearest");
      draw("ignore", 0x00040000, -8, 4);
      draw("same-slot-ignore", 0x01040000, 0, 4, 8);
      context.setTextureAt(1, texture);
      draw("two-slots-none", 0, 0, 4, 8, 1);
      draw("two-slots-ignore", 0x01040000, 0, 4, 8, 1);
      context.setTextureAt(1, null);
      var program:Program3D = context.createProgram();
      program.upload(vertex, shader(0x01000000, 8));
      context.setProgram(program);
      sample("selected-before-reupload");
      program.upload(vertex, shader(0x01000000, -8));
      sample("selected-after-reupload");
      context.setTextureAt(0, null);
      context.setTextureAt(0, texture);
      sample("rebound");
      context.configureBackBuffer(128, 128, 0, false);
      pixels.dispose(); pixels = new BitmapData(128, 128, true, 0);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([8, 8, 1, 1]));
      sample("resized");
      program.dispose();
      context.configureBackBuffer(64, 64, 0, false);
      pixels.dispose(); pixels = new BitmapData(64, 64, true, 0);
      context.clear();
      context.present();
      draw("after-present", 0x01000000, 8, 4);
      context.setTextureAt(0, cube);
      for each (bias in [-16, -1, 0, 1, 7, 8, 9, 16, 32, 64, 127]) {
        for (mip = 0; mip < 3; mip++) {
          for (var filter:int = 0; filter < 2; filter++) {
            draw("cube-f" + filter + "m" + mip + "b" + bias, (filter << 28) | (mip << 24) | 0x1000, bias, 2);
          }
        }
      }
    }
  }
}
