package {
  import flash.display.Sprite;
  import flash.display.BitmapData;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.CubeTexture;
  import flash.display3D.textures.RectangleTexture;
  import flash.display3D.textures.Texture;
  import flash.display3D.textures.TextureBase;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class ResourceObjects extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;

    public function ResourceObjects() {
      stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        context = stage.stage3Ds[0].context3D;
        context.enableErrorChecking = true;
        context.configureBackBuffer(32, 32, 0, false);
        context.clear();
        run();
        context.dispose(false);
        complete = true;
        trace("resourceobjects complete");
      });
      stage.stage3Ds[0].requestContext3D("auto", "baseline");
    }

    private function probe(label:String, action:Function):void {
      try {
        action();
        trace("resourceobjects", label, "accepted");
      } catch (error:Error) {
        trace("resourceobjects", label, error.name, error.errorID);
      }
    }

    private function run():void {
      var vertex:VertexBuffer3D;
      var index:IndexBuffer3D;
      var program:Program3D;
      var texture:Texture;
      var base:TextureBase;
      var rectangle:RectangleTexture;
      var cube:CubeTexture;
      var data:ByteArray = new ByteArray();
      data.length = 64;
      probe("context-create", function():void { new Context3D(); });
      probe("texture-base-create", function():void { base = new TextureBase(); });
      probe("vertex-create", function():void { vertex = new VertexBuffer3D(); });
      probe("index-create", function():void { index = new IndexBuffer3D(); });
      probe("program-create", function():void { program = new Program3D(); });
      probe("texture-create", function():void { texture = new Texture(); });
      probe("rectangle-create", function():void { rectangle = new RectangleTexture(); });
      probe("cube-create", function():void { cube = new CubeTexture(); });
      probe("base-bind", function():void { context.setTextureAt(0, base); });
      probe("base-target", function():void { context.setRenderToTexture(base); });
      probe("base-dispose", function():void { base.dispose(); });
      var realVertex:VertexBuffer3D = context.createVertexBuffer(3, 4);
      realVertex.uploadFromVector(Vector.<Number>([-1, -1, 0, 1, 1, -1, 0, 1, 0, 1, 0, 1]), 0, 3);
      var realIndex:IndexBuffer3D = context.createIndexBuffer(3);
      realIndex.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
      var realProgram:Program3D = context.createProgram();
      realProgram.upload(shader(false), shader(true));
      context.setProgram(realProgram);
      context.setVertexBufferAt(0, realVertex, 0, "float4");
      var realTexture:Texture = context.createTexture(1, 1, "bgra", false);
      var source:BitmapData = new BitmapData(1, 1, true, 0xff00ff00);
      var result:BitmapData = new BitmapData(32, 32, true, 0);
      realTexture.uploadFromBitmapData(source);
      context.setTextureAt(0, realTexture);
      probe("real-texture-event", function():void {
        var delivered:Boolean = false;
        realTexture.addEventListener("probe", function(event:Event):void {
          delivered = event.target === realTexture;
        });
        realTexture.dispatchEvent(new Event("probe"));
        if (!delivered) { throw new Error("Texture lost EventDispatcher initialization"); }
      });
      probe("base-bind-draw", function():void {
        context.setTextureAt(0, base);
        context.drawTriangles(realIndex);
        context.drawToBitmapData(result);
        trace("resourceobjects base-bind-pixel", result.getPixel32(16, 16).toString(16));
      });
      source.dispose(); result.dispose();
      context.setTextureAt(0, null);
      realTexture.dispose(); realProgram.dispose(); realIndex.dispose(); realVertex.dispose();
      if (vertex) {
        probe("vertex-bind", function():void { context.setVertexBufferAt(0, vertex, 0, "float4"); });
        probe("vertex-vector", function():void { vertex.uploadFromVector(Vector.<Number>([0, 0, 0, 1]), 0, 1); });
        probe("vertex-bytes", function():void { vertex.uploadFromByteArray(data, 0, 0, 1); });
        probe("vertex-dispose", function():void { vertex.dispose(); });
      }
      if (index) {
        probe("index-draw", function():void { context.drawTriangles(index); });
        probe("index-vector", function():void { index.uploadFromVector(Vector.<uint>([0, 0, 0]), 0, 3); });
        probe("index-bytes", function():void { index.uploadFromByteArray(data, 0, 0, 3); });
        probe("index-dispose", function():void { index.dispose(); });
      }
      if (program) {
        probe("program-bind", function():void { context.setProgram(program); });
        probe("program-upload", function():void { program.upload(data, data); });
        probe("program-dispose", function():void { program.dispose(); });
      }
      if (texture) {
        probe("texture-bind", function():void { context.setTextureAt(0, texture); });
        probe("texture-bytes", function():void { texture.uploadFromByteArray(data, 0); });
        probe("texture-dispose", function():void { texture.dispose(); });
      }
      if (rectangle) {
        probe("rectangle-bind", function():void { context.setTextureAt(0, rectangle); });
        probe("rectangle-dispose", function():void { rectangle.dispose(); });
      }
      if (cube) {
        probe("cube-bind", function():void { context.setTextureAt(0, cube); });
        probe("cube-dispose", function():void { cube.dispose(); });
      }
    }

    private function shader(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0); bytes.writeUnsignedInt(1);
      bytes.writeByte(0xa1); bytes.writeByte(fragment ? 1 : 0);
      bytes.writeUnsignedInt(fragment ? 0x28 : 0); bytes.writeUnsignedInt(0x030f0000);
      bytes.writeUnsignedInt(0xe4000000); bytes.writeUnsignedInt(fragment ? 1 : 0);
      bytes.writeUnsignedInt(0); bytes.writeUnsignedInt(fragment ? 5 : 0);
      return bytes;
    }
  }
}
