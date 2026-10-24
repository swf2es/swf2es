package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.Texture;
  import flash.display3D.textures.CubeTexture;
  import flash.display3D.textures.RectangleTexture;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class Reclamation extends Sprite {
    public var ready:int = 0;
    public var resources:Array;
    private var context:Context3D;
    private var indices:IndexBuffer3D;

    public function Reclamation() {
      if (stage) { start(); }
      else { addEventListener(Event.ADDED_TO_STAGE, start); }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        context = stage.stage3Ds[0].context3D;
        context.enableErrorChecking = true;
        context.configureBackBuffer(32, 32, 0, false);
        context.clear();
        bind();
        ready++;
      });
      stage.stage3Ds[0].requestContext3D("auto", "baseline");
    }

    private function shader(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0); bytes.writeUnsignedInt(1); bytes.writeByte(0xa1);
      bytes.writeByte(fragment ? 1 : 0);
      bytes.writeUnsignedInt(fragment ? 0x28 : 0);
      bytes.writeUnsignedInt(0x030f0000);
      bytes.writeUnsignedInt(0xe4000000);
      bytes.writeUnsignedInt(fragment ? 1 : 0);
      bytes.writeUnsignedInt(0);
      bytes.writeUnsignedInt(fragment ? 5 : 0);
      return bytes;
    }

    private function program():Program3D {
      var p:Program3D = context.createProgram();
      p.upload(shader(false), shader(true));
      return p;
    }

    private function bind():void {
      indices = context.createIndexBuffer(3);
      indices.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
      var vertex:VertexBuffer3D = context.createVertexBuffer(3, 4);
      vertex.uploadFromVector(Vector.<Number>([-1, -1, 0.5, 1,
        3, -1, 0.5, 1, -1, 3, 0.5, 1]), 0, 3);
      var p:Program3D = program();
      var image:Texture = context.createTexture(32, 32, "bgra", false);
      var source:BitmapData = new BitmapData(32, 32, true, 0xffff0000);
      image.uploadFromBitmapData(source); source.dispose();
      var target:Texture = context.createTexture(32, 32, "bgra", true);
      context.setVertexBufferAt(0, vertex, 0, "float4");
      context.setProgram(p);
      context.setTextureAt(0, image);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0.5, 0.5, 0, 1]));
      context.setCulling("none");
      context.setRenderToTexture(target, true);
      resources = [indices, vertex, p, image, target];
      draw();
    }

    public function draw():void {
      context.clear();
      context.drawTriangles(indices);
    }

    public function presentBack():void { context.present(); }

    public function drop():void { resources = null; }

    public function disposeBound():void {
      for (var i:int = 0; i < resources.length; i++) { resources[i].dispose(); }
      indices = null;
      resources = null;
    }

    public function unbind():void {
      context.setVertexBufferAt(0, null);
      context.setTextureAt(0, null);
      context.setRenderToBackBuffer();
      context.setProgram(program());
      indices = null;
    }

    public function invalidBinding(kind:int):void {
      switch (kind) {
        case 0: context.setVertexBufferAt(8, context.createVertexBuffer(3, 4)); break;
        case 1: context.setTextureAt(8, context.createTexture(8, 8, "bgra", false)); break;
        case 2: context.setProgram(context.createProgram()); break;
        case 3: context.setRenderToTexture(context.createTexture(4, 4, "bgra", true)); break;
      }
    }

    public function churn():void {
      var vertex:VertexBuffer3D = context.createVertexBuffer(2048, 4);
      var index:IndexBuffer3D = context.createIndexBuffer(2048);
      var p:Program3D = program();
      var image:Texture = context.createTexture(32, 32, "bgra", true);
      var cube:CubeTexture = context.createCubeTexture(8, "bgra", true);
      var rectangle:RectangleTexture = context.createRectangleTexture(17, 9, "bgra", true);
      context.setRenderToTexture(image, true); context.clear();
      context.setRenderToTexture(cube, true, 0, 2); context.clear();
      context.setRenderToTexture(rectangle, true); context.clear();
      context.setRenderToBackBuffer();
      resources = [vertex, index, p, image, cube, rectangle];
    }

    public function disposeAll():void {
      VertexBuffer3D(resources[0]).dispose();
      IndexBuffer3D(resources[1]).dispose();
      Program3D(resources[2]).dispose();
      Texture(resources[3]).dispose();
      CubeTexture(resources[4]).dispose();
      RectangleTexture(resources[5]).dispose();
    }

    public function pressure(kind:int):void {
      switch (kind) {
        case 0: resources = [context.createVertexBuffer(3, 4)]; break;
        case 1: resources = [context.createProgram()]; break;
        case 2: resources = [context.createTexture(32, 32, "bgra", false)]; break;
        case 3: resources = [context.createRectangleTexture(17, 9, "bgra", false)]; break;
        case 4: resources = [context.createIndexBuffer(3)]; break;
        case 5: resources = [context.createVertexBuffer(8192, 4)]; break;
        case 6: resources = [context.createTexture(64, 64, "bgra", false)]; break;
        case 7: resources = [context.createCubeTexture(8, "bgra", false)]; break;
      }
    }

    public function recreate():void { context.dispose(); }
  }
}
