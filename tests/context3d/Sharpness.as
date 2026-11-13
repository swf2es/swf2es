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

  // A one-pixel checkerboard of the back buffer's own pixels, drawn every frame into a 64 by 64
  // back buffer: configured for best resolution, it has the screen's pixels, and the checkerboard
  // survives on a screen of twice the density.
  public class Sharpness extends Sprite {
    public var ready:Boolean = false;
    public var sizes:String = "";
    public var best:Boolean = true;
    private var context:Context3D;
    private var indices:IndexBuffer3D;
    private var texture:Texture;
    private var textureSize:int = 0;

    public function Sharpness() {
      stage.scaleMode = "noScale";
      stage.align = "TL";
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        context = slot.context3D;
        context.enableErrorChecking = true;
        context.configureBackBuffer(64, 64, 0, false, best);
        var vertices:VertexBuffer3D = context.createVertexBuffer(4, 6);
        vertices.uploadFromVector(Vector.<Number>([
          -1, 1, 0.5, 1, 0, 0, 1, 1, 0.5, 1, 1, 0,
          -1, -1, 0.5, 1, 0, 1, 1, -1, 0.5, 1, 1, 1
        ]), 0, 4);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 2, 1, 3]), 0, 6);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        context.setVertexBufferAt(1, vertices, 4, "float2");
        var vertex:ByteArray = header(false);
        emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
        emit(vertex, 0, 0x040f0000, 0xe4000001, 0);
        var fragment:ByteArray = header(true);
        emit(fragment, 0x28, 0x020f0000, 0xe4000000, 4, 0, 5);
        emit(fragment, 0, 0x030f0000, 0xe4000000, 2);
        var program:Program3D = context.createProgram();
        program.upload(vertex, fragment);
        context.setProgram(program);
        addEventListener(Event.ENTER_FRAME, draw);
        draw();
        ready = true;
      });
      slot.requestContext3D("auto", "baseline");
    }

    /** Back buffer without best resolution, as the page asks to compare. */
    public function plain():void {
      best = false;
      context.configureBackBuffer(64, 64, 0, false, false);
      draw();
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

    private function draw(event:Event = null):void {
      // The back buffer follows the screen's density: its pixels may have changed since.
      var size:int = context.backBufferWidth;
      if (size != textureSize) {
        if (texture) {
          texture.dispose();
        }
        var board:BitmapData = new BitmapData(size, size, false, 0);
        for (var y:int = 0; y < size; y++) {
          for (var x:int = (y & 1); x < size; x += 2) {
            board.setPixel(x, y, 0xffffff);
          }
        }
        texture = context.createTexture(size, size, "bgra", false);
        texture.uploadFromBitmapData(board);
        board.dispose();
        context.setTextureAt(0, texture);
        textureSize = size;
      }

      context.clear(1, 0, 0, 1);
      context.drawTriangles(indices);
      context.present();
      sizes = stage.contentsScaleFactor + "," + context.backBufferWidth + "," + context.backBufferHeight;
    }
  }
}
