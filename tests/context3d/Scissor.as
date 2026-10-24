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

  public class Scissor extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var program:Program3D;
    private var pixels:BitmapData;

    public function Scissor() {
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
        vertices = context.createVertexBuffer(4, 4);
        vertices.uploadFromVector(Vector.<Number>([-1, -1, 0, 1, 1, -1, 0, 1, 1, 1, 0, 1, -1, 1, 0, 1]), 0, 4);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 0, 2, 3]), 0, 6);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        program = context.createProgram();
        program.upload(shader(false), shader(true));
        context.setProgram(program);
        pixels = new BitmapData(64, 64, true, 0);
        run();
        context.dispose(false);
        probe("disposed-null", function():void { context.setScissorRectangle(null); });
        probe("disposed-rect", function():void { context.setScissorRectangle(new Rectangle(1, 2, 3, 4)); });
        vertices.dispose();
        indices.dispose();
        program.dispose();
        pixels.dispose();
        complete = true;
        trace("scissor complete");
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

    private function sample(label:String):void {
      context.drawToBitmapData(pixels);
      var left:int = pixels.width;
      var top:int = pixels.height;
      var right:int = -1;
      var bottom:int = -1;
      var count:int = 0;
      for (var y:int = 0; y < pixels.height; y++) {
        for (var x:int = 0; x < pixels.width; x++) {
          if (pixels.getPixel(x, y) == 0xff0000) {
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y); count++;
          }
        }
      }
      trace("scissor", label, left, top, right, bottom, count, pixels.getPixel32(0, 0).toString(16));
    }

    private function check(label:String, rect:Rectangle):void {
      context.setScissorRectangle(null);
      context.clear(0, 0, 1, 1);
      probe(label, function():void { context.setScissorRectangle(rect); });
      probe(label + "-draw", function():void { draw(1, 0, 0, 1); });
      sample(label);
    }

    private function probe(label:String, action:Function):void {
      try { action(); trace("scissor", label, "accepted"); }
      catch (error:Error) { trace("scissor", label, error.name, error.errorID); }
    }

    private function run():void {
      check("default", null);
      check("top-left", new Rectangle(3, 7, 11, 19));
      check("fraction-low", new Rectangle(3.2, 7.2, 11.2, 19.2));
      check("fraction-sum", new Rectangle(3.4, 7.4, 11.4, 19.4));
      check("fraction-half", new Rectangle(3.5, 7.5, 11.5, 19.5));
      check("fraction-high", new Rectangle(3.8, 7.8, 11.8, 19.8));
      check("negative-offset", new Rectangle(-3.8, -7.8, 11.8, 19.8));
      check("tiny", new Rectangle(3.1, 7.1, 0.1, 0.1));
      check("edge", new Rectangle(64, 7, 11, 19));
      check("negative-height", new Rectangle(3, 7, 11, -19));
      check("outside", new Rectangle(70, 80, 9, 9));
      check("empty", new Rectangle(3, 7, 0, 19));
      check("negative-width", new Rectangle(13, 7, -11, 19));
      var rect:Rectangle = new Rectangle(3, 7, 11, 19);
      context.setScissorRectangle(rect);
      rect.setTo(40, 40, 4, 4);
      context.clear(0, 0, 1, 1);
      draw(1, 0, 0, 1);
      sample("copied");
      context.clear(0, 0, 1, 1);
      sample("clear-ignores-scissor");
      draw(1, 0, 0, 1);
      sample("clear-keeps-state");
      context.present();
      context.clear(0, 0, 1, 1);
      draw(1, 0, 0, 1);
      sample("present-keeps-state");
      context.configureBackBuffer(32, 48, 0, false);
      pixels.dispose();
      pixels = new BitmapData(32, 48, true, 0);
      context.clear(0, 0, 1, 1);
      draw(1, 0, 0, 1);
      sample("resize-keeps-state");
      context.setScissorRectangle(null);
      draw(1, 0, 0, 1);
      sample("disabled");
    }
  }
}
