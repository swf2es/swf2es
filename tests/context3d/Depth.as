package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class Depth extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var program:Program3D;
    private var pixels:BitmapData;

    public function Depth() {
      if (stage) { start(); }
      else { addEventListener(Event.ADDED_TO_STAGE, start); }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        context = slot.context3D;
        context.enableErrorChecking = true;
        context.configureBackBuffer(64, 64, 0, true);
        vertices = context.createVertexBuffer(3, 4);
        vertices.uploadFromVector(Vector.<Number>([-0.8, -0.8, 0, 1, 0.8, -0.8, 0, 1, 0, 0.8, 0, 1]), 0, 3);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 0, 2, 1]), 0, 6);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        program = context.createProgram();
        var vertex:ByteArray = header(false);
        emit(vertex, 3, 0x020f0000, 0xe4000000, 0, 0xe4000001, 1);
        emit(vertex, 1, 0x030f0000, 0xe4000000, 2, 0xe4000000, 1);
        var fragment:ByteArray = header(true);
        emit(fragment, 0, 0x030f0000, 0xe4000000, 1);
        program.upload(vertex, fragment);
        context.setProgram(program);
        pixels = new BitmapData(64, 64, true, 0);
        run();
        context.dispose(false);
        probe("disposed-depth", function():void { context.setDepthTest(true, "less"); });
        probe("disposed-cull", function():void { context.setCulling("none"); });
        probe("disposed-bad-depth", function():void { context.setDepthTest(true, "invalid"); });
        probe("disposed-bad-cull", function():void { context.setCulling("invalid"); });
        program.dispose();
        vertices.dispose();
        indices.dispose();
        pixels.dispose();
        complete = true;
        trace("depth complete");
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

    private function draw(z:Number, color:uint, reverse:Boolean = false, mirror:Boolean = false, clipW:Number = 1):void {
      context.setProgramConstantsFromVector("vertex", 0, Vector.<Number>([0, 0, z, 0]));
      context.setProgramConstantsFromVector("vertex", 1, Vector.<Number>([mirror ? -1 : 1, 1, 1, clipW]));
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([(color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255, 1]));
      context.drawTriangles(indices, reverse ? 3 : 0, 1);
    }

    private function sample():String {
      context.drawToBitmapData(pixels);
      return pixels.getPixel32(pixels.width / 2, pixels.height / 2).toString(16);
    }

    private function probe(label:String, action:Function):void {
      try { action(); trace("depth", label, "accepted"); }
      catch (error:Error) { trace("depth", label, error.name, error.errorID); }
    }

    private function run():void {
      context.clear();
      draw(0.5, 0xff0000);
      draw(0.75, 0x00ff00);
      trace("depth default-far", sample());
      draw(0.5, 0x0000ff);
      trace("depth default-equal", sample());
      context.clear();
      draw(0.5, 0xff0000, true);
      trace("depth default-reverse", sample());
      context.setCulling("none");
      var modes:Array = ["always", "never", "less", "lessEqual", "equal", "notEqual", "greaterEqual", "greater"];
      for (var i:int = 0; i < modes.length; i++) {
        var values:Array = [];
        for (var j:int = 0; j < 3; j++) {
          context.clear();
          context.setDepthTest(true, "always");
          draw(0.5, 0x0000ff);
          context.setDepthTest(true, modes[i]);
          draw(0.25 + j * 0.25, 0xff0000);
          values.push(sample());
        }
        trace("depth compare", modes[i], values.join(" "));
      }
      context.clear();
      context.setDepthTest(false, "always");
      draw(0.25, 0xff0000);
      context.setDepthTest(true, "less");
      draw(0.75, 0x00ff00);
      trace("depth write-mask", sample());
      context.clear(0, 0, 0, 1, 0.5);
      draw(0.75, 0xff0000);
      draw(0.25, 0x00ff00);
      trace("depth clear-value", sample());
      context.clear(0, 0, 1, 1, 1, 0, 1);
      draw(0.75, 0xff0000);
      trace("depth color-only-clear", sample());
      context.setDepthTest(false, "less");
      context.clear(1, 0, 0, 1, 1, 0, 2);
      trace("depth depth-only-color", sample());
      draw(0.75, 0x00ff00);
      trace("depth clear-ignores-write-mask", sample());
      draw(0.875, 0x0000ff);
      trace("depth clear-restores-write-mask", sample());
      context.clear(1, 0, 0, 1, 1, 0, 0);
      trace("depth empty-clear", sample());
      context.setDepthTest(false, "always");
      context.clear();
      draw(-0.25, 0xff0000);
      draw(1.25, 0x00ff00);
      trace("depth clip-range", sample());
      draw(1, 0x0000ff);
      trace("depth far-plane", sample());
      context.setDepthTest(true, "less");
      context.clear();
      draw(0.5, 0x0000ff);
      draw(1.5, 0xff0000, false, false, 2);
      trace("depth perspective-far", sample());
      draw(0.5, 0x00ff00, false, false, 2);
      trace("depth perspective-near", sample());
      context.setDepthTest(false, "always");
      var faces:Array = ["none", "back", "front", "frontAndBack"];
      for (i = 0; i < faces.length; i++) {
        context.setCulling(faces[i]);
        values = [];
        for (j = 0; j < 3; j++) {
          context.clear();
          draw(0.5, 0xff0000, j == 1, j == 2);
          values.push(sample());
        }
        trace("depth cull", faces[i], values.join(" "));
      }
      context.setCulling("none");
      probe("bad-compare", function():void { context.setDepthTest(true, "invalid"); });
      probe("bad-face", function():void { context.setCulling("invalid"); });
      context.setDepthTest(true, "never");
      context.configureBackBuffer(32, 32, 0, true);
      pixels.dispose();
      pixels = new BitmapData(32, 32, true, 0);
      context.clear();
      draw(0.5, 0x00ff00);
      trace("depth resize-keeps-test", sample());
      context.setDepthTest(true, "less");
      context.clear();
      draw(0.75, 0xff0000);
      draw(0.25, 0x00ff00);
      trace("depth resized-near", sample());
      context.setCulling("frontAndBack");
      context.configureBackBuffer(64, 64, 0, true);
      pixels.dispose();
      pixels = new BitmapData(64, 64, true, 0);
      context.clear();
      draw(0.5, 0xff0000);
      trace("depth resize-keeps-cull", sample());
    }
  }
}
