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
  import flash.geom.Point;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  public class Readback extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var indices:IndexBuffer3D;

    public function Readback() {
      if (stage) { start(); }
      else { addEventListener(Event.ADDED_TO_STAGE, start); }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        context = slot.context3D;
        context.enableErrorChecking = true;
        var vertices:VertexBuffer3D = context.createVertexBuffer(3, 4);
        vertices.uploadFromVector(Vector.<Number>([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]), 0, 3);
        indices = context.createIndexBuffer(3);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        var program:Program3D = context.createProgram();
        program.upload(shader(false), shader(true));
        context.setProgram(program);
        run();
        context.dispose(false);
        destinations("disposed-context");
        vertices.dispose(); indices.dispose(); program.dispose();
        complete = true;
        trace("readback complete");
      });
      slot.requestContext3D("auto", "baseline");
    }

    private function shader(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0); bytes.writeUnsignedInt(1);
      bytes.writeByte(0xa1); bytes.writeByte(fragment ? 1 : 0);
      bytes.writeUnsignedInt(0); bytes.writeUnsignedInt(0x030f0000);
      bytes.writeUnsignedInt(0xe4000000); bytes.writeUnsignedInt(fragment ? 1 : 0);
      bytes.writeUnsignedInt(0); bytes.writeUnsignedInt(0);
      return bytes;
    }

    private function fill(x:int, y:int, r:Number, g:Number, b:Number, a:Number):void {
      context.setScissorRectangle(new Rectangle(x, y, 4, 4));
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([r, g, b, a]));
      context.drawTriangles(indices);
    }

    // Each 4x4 block a colour of its own, so a copy that moved or scaled shows. Three of
    // them have channels above alpha, which the raw rows of a destination taller than the
    // back buffer keep: the player clamps such a pixel's value in a transparent BitmapData,
    // where AIR lets it spill into the channel above, so those destinations draw without them.
    private function pattern(above:Boolean = true):void {
      context.setScissorRectangle(null);
      context.clear(0.2, 0.4, 0.6, 1);
      fill(0, 0, 1, 0, 0, 1);
      fill(4, 0, 0.5, 0.25, 0, 0.5);
      fill(12, 0, 0, 0, 0, 0);
      if (above) {
        fill(8, 0, 0.25, 0.5, 0, 0.25);
        fill(16, 0, 1, 0, 0, 0);
        fill(20, 0, 0, 0, 1, 0.5);
      }
      fill(44, 0, 0, 1, 0, 1);
      fill(0, 4, 1, 1, 1, 1);
      fill(0, 28, 0, 0, 1, 1);
      fill(44, 28, 1, 1, 0, 1);
      context.setScissorRectangle(null);
    }

    private function hex(n:uint):String {
      var s:String = n.toString(16);
      while (s.length < 8) { s = "0" + s; }
      return s;
    }

    // Every 4th pixel of every 4th row, from (1, 1), and the last row and column.
    private function dump(label:String, bitmap:BitmapData):void {
      var ys:Array = [];
      for (var y:int = 1; y < bitmap.height; y += 4) { ys.push(y); }
      if (ys.indexOf(bitmap.height - 1) < 0) { ys.push(bitmap.height - 1); }
      if (ys.indexOf(0) < 0) { ys.unshift(0); }
      for each (var row:int in ys) {
        var line:Array = [];
        for (var x:int = 1; x < bitmap.width; x += 4) { line.push(hex(bitmap.getPixel32(x, row))); }
        line.push(hex(bitmap.getPixel32(bitmap.width - 1, row)));
        trace("readback", label, "row", row, line.join(" "));
      }
    }

    // What draw and copyPixels see of an opaque bitmap: its opaque view.
    private function views(label:String, bitmap:BitmapData):void {
      var drawn:BitmapData = new BitmapData(bitmap.width, bitmap.height, true, 0);
      drawn.draw(bitmap);
      var copied:BitmapData = new BitmapData(bitmap.width, bitmap.height, true, 0);
      copied.copyPixels(bitmap, bitmap.rect, new Point(0, 0));
      var y:int = Math.min(1, bitmap.height - 1);
      var line:Array = [];
      for (var x:int = 1; x < Math.min(bitmap.width, 24); x += 4) {
        line.push(hex(bitmap.getPixel(x, y)) + "/" + hex(drawn.getPixel32(x, y)) + "/" +
          hex(copied.getPixel32(x, y)) + "/" + hex(bitmap.clone().getPixel32(x, y)));
      }
      trace("readback", label, "views", line.join(" "));
      drawn.dispose();
      copied.dispose();
    }

    private function read(label:String, width:int, height:int, transparent:Boolean, fill:uint):BitmapData {
      var bitmap:BitmapData = new BitmapData(width, height, transparent, fill);
      try {
        context.drawToBitmapData(bitmap);
        trace("readback", label, "ok", bitmap.transparent);
      } catch (error:Error) {
        trace("readback", label, error.name, error.errorID);
      }
      dump(label, bitmap);
      return bitmap;
    }

    private function pixel(x:int, r:int, g:int, b:int, a:int):void {
      context.setScissorRectangle(new Rectangle(x, 0, 1, 1));
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([r / 255, g / 255, b / 255, a / 255]));
      context.drawTriangles(indices);
    }

    // Channels above alpha, as the raw rows of an opaque destination taller than the back
    // buffer keep them, and as the rows the back buffer's height covers raise them.
    private function values():void {
      context.setScissorRectangle(null);
      context.clear(0, 0, 0, 1);
      var cases:Array = [
        [255, 0, 0, 1], [0, 255, 0, 1], [0, 0, 255, 1], [255, 255, 255, 1], [1, 1, 1, 1], [2, 2, 2, 1],
        [255, 0, 0, 2], [0, 0, 255, 3], [0, 0, 255, 8], [0, 255, 0, 16], [64, 64, 64, 32],
        [0, 0, 255, 64], [128, 128, 128, 64], [200, 100, 50, 100], [255, 255, 255, 127],
        [255, 0, 0, 128], [0, 255, 0, 128], [0, 0, 255, 128], [255, 255, 255, 254],
        [10, 20, 30, 0], [255, 255, 255, 0], [128, 64, 32, 255], [40, 30, 20, 40]
      ];
      for (var i:int = 0; i < cases.length; i++) {
        pixel(i, cases[i][0], cases[i][1], cases[i][2], cases[i][3]);
      }
      context.setScissorRectangle(null);
      var opaque:BitmapData = new BitmapData(48, 40, false, 0x123456);
      var raised:BitmapData = new BitmapData(48, 32, true, 0xff123456);
      context.drawToBitmapData(opaque);
      context.drawToBitmapData(raised);
      for (i = 0; i < cases.length; i++) {
        trace("readback value", cases[i].join(","), hex(opaque.getPixel32(i, 0)),
          hex(opaque.clone().getPixel32(i, 0)), hex(raised.getPixel32(i, 0)));
      }
      opaque.dispose();
      raised.dispose();
    }

    // The rows a destination taller than the back buffer keeps raw: those above its last 32.
    private function rows(height:int):void {
      var bitmap:BitmapData = new BitmapData(16, height, false, 0x123456);
      context.drawToBitmapData(bitmap);
      var line:Array = [];
      for (var y:int = 0; y < 5; y++) { line.push(hex(bitmap.getPixel32(9, y))); }
      trace("readback rows", height, line.join(" "));
      bitmap.dispose();
    }

    private function attempt(label:String, destination:BitmapData):void {
      try {
        context.drawToBitmapData(destination);
        trace("readback", label, "ok");
      } catch (error:Error) {
        trace("readback", label, error.name, error.errorID);
      }
    }

    // A null destination, and a disposed one, which AIR checks after the clears.
    private function destinations(label:String):void {
      var disposed:BitmapData = new BitmapData(4, 4, true, 0);
      disposed.dispose();
      attempt(label + "-null", null);
      attempt(label + "-disposed", disposed);
    }

    // A column with green above alpha down the back buffer's height, read into a destination
    // 16 rows taller: the raw rows (alpha 40) and the raised ones (80), as letters.
    private function column(label:String):void {
      pattern();
      context.setScissorRectangle(new Rectangle(8, 0, 4, 32));
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0.25, 0.5, 0, 0.25]));
      context.drawTriangles(indices);
      context.setScissorRectangle(null);
      var bitmap:BitmapData = new BitmapData(16, 48, false, 0x123456);
      context.drawToBitmapData(bitmap);
      var line:String = "";
      for (var y:int = 0; y < 32; y++) {
        var alpha:uint = bitmap.getPixel32(9, y) >>> 24;
        line += alpha == 0x40 ? "N" : alpha == 0x80 ? "R" : "?";
      }
      trace("readback column", label, line);
      bitmap.dispose();
    }

    private function run():void {
      read("unconfigured", 16, 8, true, 0xff123456).dispose();
      destinations("unconfigured");
      context.configureBackBuffer(48, 32, 0, false);
      destinations("uncleared");
      pattern();
      destinations("cleared");
      read("same", 48, 32, true, 0xff123456).dispose();
      read("smaller", 16, 8, true, 0xff123456).dispose();
      read("wider", 64, 8, true, 0xff123456).dispose();
      read("tiny", 1, 1, true, 0xff123456).dispose();
      pattern(false);
      read("larger", 64, 40, true, 0xff123456).dispose();
      read("taller", 16, 40, true, 0x80123456).dispose();
      pattern();
      for each (var height:int in [31, 32, 33, 34, 35, 36, 37, 64]) { rows(height); }

      var opaque:BitmapData = read("opaque-same", 48, 32, false, 0x123456);
      views("opaque-same", opaque);
      opaque.dispose();
      opaque = read("opaque-smaller", 24, 8, false, 0x123456);
      views("opaque-smaller", opaque);
      opaque.fillRect(new Rectangle(0, 0, 4, 4), 0xff00ff);
      trace("readback opaque-smaller filled", hex(opaque.getPixel32(1, 1)), hex(opaque.getPixel32(5, 1)));
      opaque.dispose();
      opaque = read("opaque-larger", 64, 40, false, 0x123456);
      views("opaque-larger", opaque);
      opaque.dispose();
      // Alternativa3D's mouse picking: a row of opaque pixels under a scissor, read between draws.
      context.setScissorRectangle(new Rectangle(4, 4, 4, 4));
      opaque = read("opaque-row", 24, 1, false, 255);
      views("opaque-row", opaque);
      fill(0, 0, 0, 1, 1, 1);
      read("opaque-row-again", 24, 1, false, 255).dispose();
      opaque.dispose();

      context.configureBackBuffer(48, 32, 4, false);
      pattern();
      read("antialiased-smaller", 16, 8, false, 0x123456).dispose();
      read("antialiased-larger", 64, 40, false, 0x123456).dispose();
      column("antialiased");
      context.configureBackBuffer(48, 32, 0, false);
      column("plain");
      // Rendering to a texture, the read still takes the back buffer.
      var texture:Texture = context.createTexture(64, 64, "bgra", true);
      context.setRenderToTexture(texture);
      context.clear(1, 0, 0, 1);
      column("texture-target");
      context.setRenderToBackBuffer();
      texture.dispose();
      values();

      context.present();
      destinations("presented");
      read("presented-smaller", 16, 8, true, 0xff123456).dispose();
      read("presented-opaque", 16, 8, false, 0x123456).dispose();
      context.clear(0, 1, 0, 1);
      read("cleared-smaller", 16, 8, true, 0xff123456).dispose();
      read("cleared-opaque-larger", 64, 40, false, 0x123456).dispose();
    }
  }
}
