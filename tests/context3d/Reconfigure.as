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
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  public class Reconfigure extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var program:Program3D;
    private var pixels:BitmapData;

    public function Reconfigure() {
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
        trace("reconfigure complete");
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

    private function capture(label:String):void {
      context.drawToBitmapData(pixels);
      trace("reconfigure", label, pixels.getPixel32(22, 36).toString(16),
        pixels.getPixel32(42, 36).toString(16), pixels.getPixel32(2, 2).toString(16));
    }

    private function run():void {
      for (var quality:int = 0; quality <= 4; quality += 4) {
        context.configureBackBuffer(64, 64, quality, true);
        context.setDepthTest(true, "less");
        context.clear(0, 0, 1, 1);
        draw(1, 0, 0, 1);
        context.configureBackBuffer(64, 64, quality, true);
        capture("color-" + quality);
        draw(0, 1, 0, 1);
        capture("depth-" + quality);

        context.setDepthTest(false, "always");
        context.setScissorRectangle(new Rectangle(0, 0, 32, 64));
        context.setBlendFactors("one", "one");
        context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0, 0, 1, 1]));
        context.configureBackBuffer(64, 64, quality, true);
        context.drawTriangles(indices);
        capture("bindings-scissor-blend-" + quality);
        context.setCulling("frontAndBack");
        context.configureBackBuffer(64, 64, quality, true);
        draw(1, 1, 0, 1);
        capture("culling-" + quality);
        context.setCulling("none");
        context.setScissorRectangle(null);
        context.setBlendFactors("one", "zero");

        context.clear(0, 0, 1, 1, 1, 0, 1);
        context.setDepthTest(true, "less");
        context.configureBackBuffer(64, 64, quality, true);
        draw(0, 1, 0, 1);
        capture("depth-after-color-clear-" + quality);

        var texture:Texture = context.createTexture(8, 8, "bgra", true);
        context.setRenderToTexture(texture, true);
        context.clear(0, 1, 0, 1);
        context.setRenderToBackBuffer();
        context.configureBackBuffer(64, 64, quality, true);
        capture("after-target-" + quality);
        draw(1, 0, 0, 1);
        capture("depth-after-target-" + quality);
        texture.dispose();

        context.present();
        context.configureBackBuffer(64, 64, quality, true);
        context.clear(64/255, 128/255, 192/255, 1);
        context.configureBackBuffer(64, 64, quality, true);
        capture("cleared-after-present-" + quality);
      }
    }
  }
}
