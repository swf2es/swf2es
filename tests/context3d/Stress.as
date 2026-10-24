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
  import flash.display3D.textures.RectangleTexture;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class Stress extends Sprite {
    public var ready:int = 0;
    public var created:int = 0;
    public var checks:int = 0;
    public var retained:Array = [];
    private var contexts:Array = [null, null];

    public function Stress() {
      if (stage) { start(); }
      else { addEventListener(Event.ADDED_TO_STAGE, start); }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      attach(0); attach(1);
    }

    private function attach(index:int):void {
      var slot:Stage3D = stage.stage3Ds[index];
      slot.x = index * 13; slot.y = index * 7;
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        contexts[index] = slot.context3D;
        slot.context3D.enableErrorChecking = true;
        created++;
        ready = int(contexts[0] != null) + int(contexts[1] != null);
      });
      slot.requestContext3D("auto", "baseline");
    }

    public function recreate():void {
      ready = 0;
      for (var i:int = 0; i < 2; i++) {
        var context:Context3D = contexts[i];
        contexts[i] = null;
        context.dispose();
      }
    }

    public function churn(iteration:int):void {
      for (var i:int = 0; i < 2; i++) { exercise(contexts[i], iteration + i); }
    }

    private function shader(kind:int):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0); bytes.writeUnsignedInt(1); bytes.writeByte(0xa1);
      bytes.writeByte(kind == 0 ? 0 : 1);
      bytes.writeUnsignedInt(kind > 1 ? 0x28 : 0);
      bytes.writeUnsignedInt(0x030f0000);
      bytes.writeUnsignedInt(0xe4000000);
      bytes.writeUnsignedInt(kind == 0 ? 0 : 1);
      bytes.writeUnsignedInt(0);
      bytes.writeUnsignedInt(kind == 3 ? 0x1005 : kind == 2 ? 5 : 0);
      return bytes;
    }

    private function capture(context:Context3D, pixels:BitmapData, color:uint):void {
      context.clear();
      context.drawTriangles(indexBuffer, 0, 1);
      context.drawToBitmapData(pixels);
      if (pixels.getPixel32(pixels.width / 2, pixels.height / 2) != color) {
        throw new Error("stress pixel mismatch");
      }
      checks++;
    }

    private var indexBuffer:IndexBuffer3D;

    private function exercise(context:Context3D, iteration:int):void {
      var size:int = 64 << (iteration % 3);
      context.configureBackBuffer(size, size, iteration % 2 ? 4 : 0, true);
      // Unchanged configuration must retain the same backing resources.
      context.configureBackBuffer(size, size, iteration % 2 ? 4 : 0, true);
      var vertex:VertexBuffer3D = context.createVertexBuffer(4096, 4);
      vertex.uploadFromVector(Vector.<Number>([-1, -1, 0.5, 1, 3, -1, 0.5, 1, -1, 3, 0.5, 1]), 0, 3);
      indexBuffer = context.createIndexBuffer(32768);
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeShort(0); bytes.writeShort(1); bytes.writeShort(2);
      indexBuffer.uploadFromByteArray(bytes, 0, 0, 3);
      context.setVertexBufferAt(0, vertex, 0, "float4");
      context.setCulling("none");
      var solid:Program3D = context.createProgram(); solid.upload(shader(0), shader(1));
      var flat:Program3D = context.createProgram(); flat.upload(shader(0), shader(2));
      var cubeProgram:Program3D = context.createProgram(); cubeProgram.upload(shader(0), shader(3));
      var image:Texture = context.createTexture(256, 256, "bgra", true);
      var rectangle:RectangleTexture = context.createRectangleTexture(97, 65, "bgra", true);
      var cube:CubeTexture = context.createCubeTexture(32, "bgra", true);
      var source:BitmapData = new BitmapData(256, 256, true, 0xffff0000);
      image.uploadFromBitmapData(source);
      image.uploadFromBitmapData(source);
      source.fillRect(source.rect, 0xffffffff);
      bytes.length = 97 * 65 * 4 + 3;
      bytes.position = 3; bytes.writeUnsignedInt(0xff00ff00);
      rectangle.uploadFromByteArray(bytes, 3);
      rectangle.uploadFromBitmapData(source);
      var pixels:BitmapData = new BitmapData(size, size, true, 0);
      context.setProgram(flat);
      context.setTextureAt(0, image);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0.5, 0.5, 0, 1]));
      capture(context, pixels, 0xffff0000);
      context.setTextureAt(0, null);
      context.setProgram(solid);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0, 1, 0, 1]));
      for (var face:int = 0; face < 6; face++) {
        context.setRenderToTexture(cube, true, 0, face);
        context.clear(); context.drawTriangles(indexBuffer, 0, 1);
      }
      context.setRenderToTexture(rectangle, false);
      context.clear(); context.drawTriangles(indexBuffer, 0, 1);
      context.setRenderToBackBuffer();
      context.setProgram(flat);
      context.setTextureAt(0, rectangle);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0.5, 0.5, 0, 1]));
      capture(context, pixels, 0xff00ff00);
      context.setTextureAt(0, cube);
      context.setProgram(cubeProgram);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 1]));
      capture(context, pixels, 0xff00ff00);
      context.present();
      source.dispose(); pixels.dispose();
      // Keep AS wrappers alive across scene changes, even after explicit disposal.
      retained.push(vertex, indexBuffer, solid, flat, cubeProgram, image, rectangle, cube);
      if (iteration % 3 != 2) {
        vertex.dispose(); indexBuffer.dispose();
        solid.dispose(); flat.dispose(); cubeProgram.dispose();
        image.dispose(); rectangle.dispose(); cube.dispose();
      }
    }
  }
}
