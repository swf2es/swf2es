package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.Texture;
  import flash.display3D.textures.RectangleTexture;
  import flash.events.Event;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  public class RectangleTextures extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var texture:RectangleTexture;

    private var pixels:BitmapData;
    private var vertex:ByteArray;

    public function RectangleTextures() {
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
        vertices = context.createVertexBuffer(4, 7);
        vertices.uploadFromVector(Vector.<Number>([
          -1, 1, 0.5, 1, 0, 0, 1, 1, 1, 0.5, 1, 1, 0, 1,
          -1, -1, 0.5, 1, 0, 1, 1, 1, -1, 0.5, 1, 1, 1, 1
        ]), 0, 4);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 2, 1, 3]), 0, 6);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        context.setVertexBufferAt(1, vertices, 4, "float3");
        context.setCulling("none");
        pixels = new BitmapData(64, 64, true, 0);
        vertex = header(false);
        emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
        emit(vertex, 0, 0x040f0000, 0xe4000001, 0);
        run();
        vertices.dispose(); indices.dispose(); pixels.dispose(); texture.dispose();
        context.dispose(false);
        complete = true;
        trace("rectangletextures complete");
      });
      slot.requestContext3D("auto", "baseline");
    }

    private function header(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0); bytes.writeUnsignedInt(1);
      bytes.writeByte(0xa1); bytes.writeByte(fragment ? 1 : 0);
      return bytes;
    }

    private function emit(bytes:ByteArray, op:uint, dest:uint, a:uint, at:uint, b:uint = 0, bt:uint = 0):void {
      bytes.writeUnsignedInt(op); bytes.writeUnsignedInt(dest);
      bytes.writeUnsignedInt(a); bytes.writeUnsignedInt(at);
      bytes.writeUnsignedInt(b); bytes.writeUnsignedInt(bt);
    }

    private function shader(flags:uint):ByteArray {
      var bytes:ByteArray = header(true);
      emit(bytes, 0x28, 0x030f0000, 0xe4000000, 1, 0, flags | 5);
      return bytes;
    }

    private function sample(label:String, flags:uint = 0, override:String = null):void {
      var program:Program3D = context.createProgram();
      var phase:String = "upload";
      try {
        program.upload(vertex, shader(flags));
        context.setProgram(program);
        if (override == "repeat") { context.setSamplerStateAt(0, "repeat", "nearest", "mipnone"); }
        if (override == "mip") { context.setSamplerStateAt(0, "clamp", "nearest", "mipnearest"); }
        if (override == "clamp") { context.setSamplerStateAt(0, "clamp", "nearest", "mipnone"); }
        phase = "draw";
        var points:Array = [[0.01, 0.01], [0.5, 0.5], [0.99, 0.99], [-1, -1], [2, 2]];
        var values:Array = [];
        for (var i:int = 0; i < points.length; i++) {
          context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([points[i][0], points[i][1], 1, 1]));
          context.clear(0, 0, 0, 1);
          context.drawTriangles(indices);
          context.drawToBitmapData(pixels);
          values.push(pixels.getPixel32(32, 32).toString(16));
        }
        trace("rectangletextures", label, values.join(" "));
      } catch (error:Error) { trace("rectangletextures", label, phase, error.name, error.errorID); }
      program.dispose();
    }

    private function attempt(label:String, fn:Function):void {
      try { fn(); trace("rectangletextures", label, "accepted"); }
      catch (error:Error) { trace("rectangletextures", label, error.name, error.errorID); }
    }

    private function renderTarget():void {
      var target:RectangleTexture = context.createRectangleTexture(17, 9, "bgra", true);
      context.setTextureAt(0, null);
      context.setRenderToTexture(target, true);
      context.clear(0, 0, 1, 1);
      context.setRenderToBackBuffer();
      context.setTextureAt(0, target);
      sample("target-clear");
      context.setTextureAt(0, null);
      context.setRenderToTexture(target, false);
      context.setScissorRectangle(new Rectangle(0, 0, 17, 4));
      var solid:ByteArray = header(true);
      emit(solid, 0, 0x030f0000, 0xe4000000, 1);
      var fill:Program3D = context.createProgram();
      fill.upload(vertex, solid);
      context.setProgram(fill);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 1]));
      context.drawTriangles(indices);
      fill.dispose();
      context.setScissorRectangle(null);
      context.setRenderToBackBuffer();
      context.setTextureAt(0, target);
      sample("target-scissor");
      context.setRenderToTexture(target, true);
      sample("target-feedback");
      context.setTextureAt(0, null);
      context.setRenderToBackBuffer();
      context.setTextureAt(0, target);
      sample("target-after-feedback");
      context.present();
      sample("target-present");
      context.setTextureAt(0, null);
      context.setRenderToTexture(target, false);
      context.setRenderToBackBuffer();
      context.setTextureAt(0, target);
      sample("target-retained");
      context.setTextureAt(0, null);
      target.dispose();
    }

    private function run():void {
      texture = context.createRectangleTexture(3, 5, "bgra", false);
      trace("rectangletextures type", texture is RectangleTexture);
      context.setTextureAt(0, texture);
      sample("unuploaded");
      var bitmap:BitmapData = new BitmapData(3, 5, true, 0xff00ff00);
      bitmap.setPixel32(0, 0, 0xffff0000);
      bitmap.setPixel32(2, 4, 0xff0000ff);
      texture.uploadFromBitmapData(bitmap);
      sample("nearest");
      sample("linear", 0x10000000);
      sample("repeat", 0x00100000);
      sample("mipnearest", 0x01000000);
      sample("miplinear", 0x02000000);
      sample("override-repeat", 0, "repeat");
      sample("override-mip", 0, "mip");
      sample("cube-dimension", 0x1000);
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(99);
      for (var i:int = 0; i < 15; i++) { bytes.writeUnsignedInt(i == 0 ? 0x80204060 : 0xff4488cc); }
      bytes.position = 7;
      texture.uploadFromByteArray(bytes, 1);
      trace("rectangletextures byte-state", bytes.position, bytes.length, bytes.endian);
      sample("bytes");
      attempt("short-bytes", function():void { texture.uploadFromByteArray(bytes, 2); });
      attempt("null-bytes", function():void { texture.uploadFromByteArray(null, 0); });
      attempt("null-bitmap", function():void { texture.uploadFromBitmapData(null); });
      sample("after-failed-upload");
      texture.uploadFromBitmapData(bitmap);
      bitmap.fillRect(bitmap.rect, 0xffffffff);
      sample("source-mutated");
      context.setTextureAt(0, null);
      context.setTextureAt(0, texture);
      sample("rebound");
      context.present();
      sample("present");
      var power:Texture = context.createTexture(4, 4, "bgra", false);
      var image:BitmapData = new BitmapData(4, 4, true, 0xffffff00);
      power.uploadFromBitmapData(image);
      context.setTextureAt(0, power);
      sample("ordinary");
      context.setTextureAt(0, texture);
      sample("rectangle-again");
      power.dispose(); image.dispose();
      attempt("width-zero", function():void { context.createRectangleTexture(0, 5, "bgra", false); });
      attempt("height-zero", function():void { context.createRectangleTexture(3, 0, "bgra", false); });
      attempt("width-limit", function():void { context.createRectangleTexture(2049, 5, "bgra", false); });
      attempt("height-limit", function():void { context.createRectangleTexture(3, 2049, "bgra", false); });
      attempt("format-invalid", function():void { context.createRectangleTexture(3, 5, "bad", false); });
      attempt("format-null", function():void { context.createRectangleTexture(3, 5, null, false); });
      attempt("zero-invalid-format", function():void { context.createRectangleTexture(0, 0, "bad", false); });
      attempt("zero-null-format", function():void { context.createRectangleTexture(0, 0, null, false); });
      attempt("zero-limit", function():void { context.createRectangleTexture(0, 2049, "bgra", false); });
      attempt("limit-invalid-format", function():void { context.createRectangleTexture(2049, 3, "bad", false); });
      attempt("negative-size", function():void { context.createRectangleTexture(-1, 3, "bgra", false); });
      sample("ignore-repeat", 0x00140000);
      sample("ignore-mip", 0x01040000);
      sample("override-clamp-repeat", 0x00100000, "clamp");
      sample("override-clamp-mip", 0x01000000, "clamp");
      renderTarget();
      context.setTextureAt(0, texture);
      var small:BitmapData = new BitmapData(1, 1, true, 0xffffff00);
      attempt("small-bitmap", function():void { texture.uploadFromBitmapData(small); });
      sample("after-small");
      var big:BitmapData = new BitmapData(6, 10, true, 0xffff00ff);
      big.setPixel32(2, 4, 0xff00ffff);
      big.setPixel32(5, 9, 0xffffff00);
      attempt("big-bitmap", function():void { texture.uploadFromBitmapData(big); });
      sample("after-big");
      texture.dispose();
      attempt("disposed-bitmap", function():void { texture.uploadFromBitmapData(bitmap); });
      attempt("disposed-null-bitmap", function():void { texture.uploadFromBitmapData(null); });
      attempt("disposed-bytes", function():void { texture.uploadFromByteArray(bytes, 999); });
      attempt("disposed-null-bytes", function():void { texture.uploadFromByteArray(null, 0); });
      context.setTextureAt(0, texture);
      sample("disposed-draw");
      bitmap.dispose(); small.dispose(); big.dispose();
      var retired:RectangleTexture = context.createRectangleTexture(3, 5, "bgra", false);
      context.dispose(false);
      attempt("owner-bitmap", function():void { retired.uploadFromBitmapData(pixels); });
      attempt("owner-null-bitmap", function():void { retired.uploadFromBitmapData(null); });
      attempt("owner-bytes", function():void { retired.uploadFromByteArray(bytes, 0); });
      attempt("owner-null-bytes", function():void { retired.uploadFromByteArray(null, 0); });
      attempt("disposed-owner-bitmap", function():void { texture.uploadFromBitmapData(pixels); });
      attempt("disposed-owner-bytes", function():void { texture.uploadFromByteArray(bytes, 0); });
      attempt("owner-create", function():void { context.createRectangleTexture(3, 5, "bgra", false); });
      attempt("owner-create-null", function():void { context.createRectangleTexture(3, 5, null, false); });
    }
  }
}
