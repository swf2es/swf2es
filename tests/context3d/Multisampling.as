package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.events.Event;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  public class Multisampling extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var program:Program3D;
    private var pixels:BitmapData;

    public function Multisampling() {
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
        indices = context.createIndexBuffer(3);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        program = context.createProgram();
        program.upload(shader(false), shader(true));
        context.setProgram(program);
        pixels = new BitmapData(64, 64, true, 0);
        run();
        context.dispose(false);
        vertices.dispose();
        indices.dispose();
        program.dispose();
        pixels.dispose();
        complete = true;
        trace("multisampling complete");
      });
      slot.requestContext3D("auto", "baseline");
    }

    private function shader(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0);
      bytes.writeUnsignedInt(1);
      bytes.writeByte(0xa1);
      bytes.writeByte(fragment ? 1 : 0);
      bytes.writeUnsignedInt(0);
      bytes.writeUnsignedInt(0x030f0000);
      bytes.writeUnsignedInt(0xe4000000);
      bytes.writeUnsignedInt(fragment ? 1 : 0);
      bytes.writeUnsignedInt(0);
      bytes.writeUnsignedInt(0);
      return bytes;
    }

    private function draw(r:Number, g:Number, b:Number, a:Number):void {
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([r, g, b, a]));
      context.drawTriangles(indices);
    }

    private function sample():String {
      context.drawToBitmapData(pixels);
      return pixels.getPixel32(pixels.width / 2, pixels.height / 2).toString(16);
    }

    private function probe(label:String, action:Function):void {
      try { action(); trace("multisampling", label, "accepted"); }
      catch (error:Error) { trace("multisampling", label, error.name, error.errorID); }
    }

    private function run():void {
      context.setDepthTest(false, "always");
      var qualities:Array = [-1, 0, 1, 2, 3, 4, 8, 16, 17];
      for (var i:int = 0; i < qualities.length; i++) {
        var quality:int = qualities[i];
        probe("configure-" + quality, function():void { context.configureBackBuffer(64, 64, quality, true); });
        context.clear(0, 0, 1, 1);
        draw(1, 0, 0, 1);
        trace("multisampling center-" + quality, sample());
      }
      context.configureBackBuffer(64, 64, 4, true);
      context.clear(0, 0, 1, 1);
      draw(1, 0, 0, 1);
      trace("multisampling read", sample());
      trace("multisampling read-again", sample());
      context.setScissorRectangle(new Rectangle(28, 28, 8, 8));
      context.present();
      context.clear(0, 1, 0, 1);
      trace("multisampling after-clear", sample());
      draw(1, 0, 0, 1);
      trace("multisampling scissor-draw", sample());
      trace("multisampling scissor-outside", pixels.getPixel32(0, 0).toString(16));
      context.setScissorRectangle(null);
      context.configureBackBuffer(32, 48, 2, true);
      pixels.dispose();
      pixels = new BitmapData(32, 48, true, 0);
      context.clear(0, 0, 1, 1);
      draw(1, 0, 0, 1);
      trace("multisampling resize", sample());
      context.configureBackBuffer(32, 48, 0, true);
      context.clear(0, 0, 1, 1);
      draw(0, 1, 0, 1);
      trace("multisampling disabled", sample());
    }
  }
}
