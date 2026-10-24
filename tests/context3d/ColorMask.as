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

  public class ColorMask extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var program:Program3D;
    private var pixels:BitmapData;

    public function ColorMask() {
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
        probe("disposed", function():void { context.setColorMask(false, false, false, false); });
        vertices.dispose();
        indices.dispose();
        program.dispose();
        pixels.dispose();
        complete = true;
        trace("colormask complete");
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
      try { action(); trace("colormask", label, "accepted"); }
      catch (error:Error) { trace("colormask", label, error.name, error.errorID); }
    }

    private function mask(bits:int):void {
      context.setColorMask((bits & 1) != 0, (bits & 2) != 0, (bits & 4) != 0, (bits & 8) != 0);
    }

    private function capture(label:String):void {
      trace("colormask", label, sample());
    }

    private function run():void {
      context.setDepthTest(false, "always");
      context.clear(0, 0, 1, 1);
      draw(1, 0, 0, 1);
      capture("default");
      for (var quality:int = 0; quality <= 4; quality += 4) {
        context.configureBackBuffer(64, 64, quality, true);
        for (var bits:int = 0; bits < 16; bits++) {
          mask(bits);
          context.clear(51 / 255, 102 / 255, 153 / 255, 204 / 255);
          capture("clear-" + quality + "-" + bits);
          draw(102 / 255, 51 / 255, 51 / 255, 1);
          capture("draw-" + quality + "-" + bits);
        }
        mask(1);
        context.clear(0, 0, 1, 1);
        context.configureBackBuffer(64, 64, quality, true);
        draw(1, 1, 0, 1);
        capture("same-config-" + quality);
        context.present();
        context.clear(0, 0, 1, 1);
        draw(1, 1, 0, 1);
        capture("present-" + quality);
        mask(0);
        context.clear(0, 0, 1, 1);
        context.setDepthTest(true, "less");
        draw(1, 0, 0, 1);
        mask(15);
        draw(0, 1, 0, 1);
        capture("depth-only-pass-" + quality);
        mask(2);
        context.clear(0, 0, 0, 0, 1, 0, 2);
        draw(1, 1, 0, 1);
        capture("depth-clear-keeps-mask-" + quality);
        context.setDepthTest(false, "always");
      }
      mask(1);
      context.configureBackBuffer(32, 32, 0, true);
      pixels.dispose();
      pixels = new BitmapData(32, 32, true, 0);
      context.clear(0, 0, 1, 1);
      draw(1, 1, 0, 1);
      capture("resize");

      var target:Texture = context.createTexture(32, 32, "bgra", true);
      context.setRenderToTexture(target, true);
      context.clear(0, 0, 1, 1);
      draw(1, 1, 0, 1);
      context.setRenderToBackBuffer();
      context.clear(0, 1, 0, 1);
      draw(1, 0, 1, 1);
      capture("target-return");

      var vs:ByteArray = shader(false);
      vs.position = vs.length;
      // mov v0, vc0: sample the target's center throughout the triangle.
      vs.writeUnsignedInt(0); vs.writeUnsignedInt(0x040f0000);
      vs.writeUnsignedInt(0xe4000000); vs.writeUnsignedInt(1);
      vs.writeUnsignedInt(0); vs.writeUnsignedInt(0);
      var fs:ByteArray = shader(true);
      fs.position = 7;
      fs.writeUnsignedInt(0x28); fs.writeUnsignedInt(0x030f0000);
      fs.writeUnsignedInt(0xe4000000); fs.writeUnsignedInt(4);
      fs.writeUnsignedInt(0); fs.writeUnsignedInt(5);
      var sampled:Program3D = context.createProgram();
      sampled.upload(vs, fs);
      context.setProgram(sampled);
      context.setProgramConstantsFromVector("vertex", 0, Vector.<Number>([0.5, 0.5, 0, 0]));
      context.setTextureAt(0, target);
      mask(15);
      context.clear(0, 0, 0, 1);
      context.drawTriangles(indices);
      capture("target-color");
      context.setTextureAt(0, null);
      context.setProgram(program);
      sampled.dispose();
      target.dispose();

      context.setBlendFactors("one", "one");
      mask(2);
      context.clear(51 / 255, 51 / 255, 51 / 255, 1);
      draw(51 / 255, 51 / 255, 51 / 255, 1);
      capture("additive-mask");
    }
  }
}
