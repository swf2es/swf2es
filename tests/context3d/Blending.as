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

  public class Blending extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var program:Program3D;
    private var pixels:BitmapData;

    public function Blending() {
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
        probe("disposed", function():void { context.setBlendFactors("one", "zero"); });
        probe("disposed-bad-source", function():void { context.setBlendFactors("invalid", "zero"); });
        probe("disposed-bad-destination", function():void { context.setBlendFactors("one", "invalid"); });
        vertices.dispose();
        indices.dispose();
        program.dispose();
        pixels.dispose();
        complete = true;
        trace("blending complete");
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
      try { action(); trace("blending", label, "accepted"); }
      catch (error:Error) { trace("blending", label, error.name, error.errorID); }
    }

    private function run():void {
      context.clear(0, 0, 1, 1);
      draw(1, 0, 0, 0);
      trace("blending default", sample());
      var factors:Array = ["zero", "one", "sourceColor", "oneMinusSourceColor", "sourceAlpha", "oneMinusSourceAlpha", "destinationColor", "oneMinusDestinationColor", "destinationAlpha", "oneMinusDestinationAlpha"];
      for (var i:int = 0; i < factors.length; i++) {
        for (var j:int = 0; j < factors.length; j++) {
          context.clear(102 / 255, 51 / 255, 0, 153 / 255);
          context.setBlendFactors(factors[i], factors[j]);
          draw(51 / 255, 102 / 255, 153 / 255, 204 / 255);
          trace("blending pair", factors[i], factors[j], sample());
        }
      }
      context.setBlendFactors("one", "one");
      context.clear(0, 0, 0, 0);
      draw(1, 0, 0, 1);
      draw(1, 1, 0, 1);
      trace("blending additive-clamp", sample());
      context.setBlendFactors("sourceAlpha", "oneMinusSourceAlpha");
      context.clear(0, 0, 1, 1);
      draw(1, 0, 0, 0);
      trace("blending zero-alpha", sample());
      draw(0, 1, 0, 1);
      trace("blending full-alpha", sample());
      context.setBlendFactors("one", "oneMinusSourceAlpha");
      context.clear(0, 0, 1, 1);
      draw(51 / 255, 0, 0, 51 / 255);
      trace("blending premultiplied", sample());
      context.setBlendFactors("zero", "one");
      probe("bad-source", function():void { context.setBlendFactors("invalid", "zero"); });
      probe("bad-destination", function():void { context.setBlendFactors("one", "invalid"); });
      draw(1, 0, 0, 1);
      trace("blending invalid-keeps-state", sample());
      context.clear(0, 1, 0, 1);
      trace("blending clear-ignores-state", sample());
      context.configureBackBuffer(32, 32, 0, false);
      pixels.dispose();
      pixels = new BitmapData(32, 32, true, 0);
      context.clear(0, 0, 1, 1);
      draw(1, 0, 0, 1);
      trace("blending resize-keeps-state", sample());
      context.setBlendFactors("one", "zero");
      draw(0, 1, 0, 1);
      trace("blending replace", sample());
      context.setBlendFactors("zero", "one");
      context.present();
      context.clear(0, 0, 1, 1);
      draw(1, 0, 0, 1);
      trace("blending present-keeps-state", sample());
    }
  }
}
