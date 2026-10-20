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

  public class Texturing extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var texture:Texture;
    private var second:Texture;
    private var pixels:BitmapData;
    private var vertex:ByteArray;

    public function Texturing() {
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
        texture.dispose();
        var probe:BitmapData = new BitmapData(2, 2, true, 0);
        try { texture.uploadFromBitmapData(probe); trace("texturing disposed-upload accepted"); }
        catch (error:Error) { trace("texturing disposed-upload", error.name, error.errorID); }
        try { context.setTextureAt(0, texture); trace("texturing disposed-bind accepted"); }
        catch (error:Error) { trace("texturing disposed-bind", error.name, error.errorID); }
        draw("disposed-draw", 0, false, false, false, 3);
        vertices.dispose();
        indices.dispose();
        pixels.dispose();
        texture.dispose();
        context.dispose(false);
        try { second.uploadFromBitmapData(probe); trace("texturing retired-upload accepted"); }
        catch (error:Error) { trace("texturing retired-upload", error.name, error.errorID); }
        second.dispose();
        probe.dispose();
        complete = true;
        trace("texturing complete");
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

    private function draw(label:String, flags:uint, constant:Boolean = false, dual:Boolean = false, opaque:Boolean = false, invalid:int = 0):void {
      var fragment:ByteArray = header(true);
      emit(fragment, 0, 0x020f0000, constant ? 0xe4000001 : 0xe4000000, constant ? 1 : 4);
      emit(fragment, 1, 0x020f0000, 0xe4000000, 2, 0xe4000000, 1);
      emit(fragment, 0x28, 0x020f0001, 0xe4000000, 2, 0, flags | 5);
      if (dual) {
        emit(fragment, 0x28, 0x020f0002, 0xe4000000, 2, 1, 0x00100005);
        emit(fragment, 1, 0x020f0001, 0xe4000001, 2, 0xe4000002, 2);
        emit(fragment, 3, 0x020f0001, 0xe4000001, 2, 0xe4000002, 1);
      }
      if (opaque) { emit(fragment, 0, 0x02080001, 0xe4000001, 1); }
      emit(fragment, 0, 0x030f0000, 0xe4000001, 2);
      var program:Program3D = context.createProgram();
      program.upload(vertex, fragment);
      context.setProgram(program);
      context.setTextureAt(1, invalid == 1 || invalid == 2 ? texture : dual ? second : null);
      context.clear(0, 0, 0, 1);
      try {
        context.drawTriangles(indices);
        if (invalid != 0) {
          trace("texturing", label, "accepted");
        } else {
          context.drawToBitmapData(pixels);
          trace("texturing", label, pixels.getPixel32(16, 16).toString(16), pixels.getPixel32(48, 16).toString(16),
            pixels.getPixel32(16, 48).toString(16), pixels.getPixel32(48, 48).toString(16));
        }
      } catch (error:Error) {
        if (invalid == 0) { throw error; }
        trace("texturing", label, error.name, error.errorID);
      }
      program.dispose();
    }

    private function run():void {
      var bitmap:BitmapData = new BitmapData(2, 2, true, 0);
      bitmap.setPixel32(0, 0, 0xffff0000);
      bitmap.setPixel32(1, 0, 0xff00ff00);
      bitmap.setPixel32(0, 1, 0xff0000ff);
      bitmap.setPixel32(1, 1, 0xffffff00);
      texture = context.createTexture(2, 2, "bgra", false);
      texture.uploadFromBitmapData(bitmap);
      second = context.createTexture(2, 2, "bgra", false);
      second.uploadFromBitmapData(bitmap);
      context.setTextureAt(0, texture);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0, 0, 0, 0]));
      context.setProgramConstantsFromVector("fragment", 1, Vector.<Number>([0.5, 0.5, 0, 1]));
      context.setProgramConstantsFromVector("fragment", 2, Vector.<Number>([0.5, 0.5, 0.5, 0.5]));
      draw("corners", 0);
      draw("linear-center", 0x10000000, true);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 0]));
      draw("clamp", 0);
      draw("repeat", 0x00100000);
      draw("independent-samplers", 0, false, true);
      draw("unused-sampler", 0, false, false, false, 1);
      draw("conflicting-samplers", 0, false, true, false, 2);
      context.setTextureAt(1, null);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0, 0, 0, 0]));
      bitmap.setPixel32(0, 0, 0x804080c0);
      bitmap.setPixel32(1, 0, 0x00010203);
      texture.uploadFromBitmapData(bitmap);
      bitmap.dispose();
      draw("alpha", 0);
      draw("alpha-rgb", 0, false, false, true);
      context.setTextureAt(0, null);
      context.setTextureAt(0, texture);
      draw("rebound", 0);
      context.clear(64 / 255, 128 / 255, 192 / 255, 128 / 255);
      context.drawToBitmapData(pixels);
      trace("texturing clear-alpha", pixels.getPixel32(16, 16).toString(16));
    }
  }
}
