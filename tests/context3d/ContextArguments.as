package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.CubeTexture;
  import flash.display3D.textures.Texture;
  import flash.events.Event;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  // What AIR 51 takes of Context3D's arguments past the usual: clear's masks above 7, buffer
  // usages, data32PerVertex at its limits, vertex buffer indices up to 15, program types,
  // setProgramConstantsFromByteArray, and texture streaming levels as AIR samples them.
  public class ContextArguments extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var flat:Program3D;
    private var pixels:BitmapData = new BitmapData(64, 64, true, 0);

    public function ContextArguments() {
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
        vertices = context.createVertexBuffer(4, 6);
        vertices.uploadFromVector(Vector.<Number>([
          -1, 1, 0.5, 1, 0, 0, 1, 1, 0.5, 1, 1, 0,
          -1, -1, 0.5, 1, 0, 1, 1, -1, 0.5, 1, 1, 1
        ]), 0, 4);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 2, 1, 3]), 0, 6);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        context.setCulling("none");
        flat = context.createProgram();
        var v:ByteArray = header(false);
        emit(v, 0, 0x030f0000, 0xe4000000, 0);
        var f:ByteArray = header(true);
        emit(f, 0, 0x030f0000, 0xe4000000, 1);
        flat.upload(v, f);
        run();
        context.dispose(false);
        vertices.dispose();
        indices.dispose();
        flat.dispose();
        pixels.dispose();
        complete = true;
        trace("contextarguments complete");
      });
      slot.requestContext3D("auto", "baseline");
    }

    private function header(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0); bytes.writeUnsignedInt(1); bytes.writeByte(0xa1); bytes.writeByte(fragment ? 1 : 0);
      return bytes;
    }

    private function emit(bytes:ByteArray, op:uint, dest:uint, a:uint, at:uint, b:uint = 0, bt:uint = 0):void {
      bytes.writeUnsignedInt(op); bytes.writeUnsignedInt(dest); bytes.writeUnsignedInt(a);
      bytes.writeUnsignedInt(at); bytes.writeUnsignedInt(b); bytes.writeUnsignedInt(bt);
    }

    private function probe(label:String, action:Function):void {
      try { var r:* = action(); trace("contextarguments", label, "ok", r === undefined ? "" : r); }
      catch (error:Error) { trace("contextarguments", label, error.name, error.errorID); }
    }

    private function pixel():String {
      context.drawToBitmapData(pixels);
      return pixels.getPixel32(40, 40).toString(16) + " " + pixels.getPixel32(5, 5).toString(16);
    }

    private function masks():void {
      context.setProgram(flat);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 1]));
      var list:Array = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 0x7fffffff, 0xfffffff8, 0xfffffffe, 0xffffffff];
      for each (var mask:uint in list) {
        context.clear(1, 1, 0, 1);
        context.present();
        var clearResult:String = "ok";
        try { context.clear(0, 0, 1, 1, 0.25, 3, mask); } catch (error:Error) { clearResult = error.name + " " + error.errorID; }
        context.setScissorRectangle(new Rectangle(0, 0, 10, 10));
        var drawResult:String = "ok";
        try { context.drawTriangles(indices); } catch (error:Error) { drawResult = error.name + " " + error.errorID; }
        context.setScissorRectangle(null);
        var read:String;
        try { read = pixel(); } catch (error:Error) { read = error.name + " " + error.errorID; }
        trace("contextarguments mask", mask.toString(16), clearResult, drawResult, read);
        try { context.present(); } catch (error:Error) { trace("contextarguments mask present", error.errorID); }
      }
      context.clear();
    }

    private function buffers():void {
      for each (var stride:int in [-1, 0, 1, 64, 65]) {
        probe("stride " + stride, function():* { context.createVertexBuffer(4, stride).dispose(); });
      }
      for each (var usage:* in ["staticDraw", "dynamicDraw", "bogus", "", null, "DynamicDraw"]) {
        probe("vusage " + usage, function():* { context.createVertexBuffer(4, 4, usage).dispose(); });
        probe("iusage " + usage, function():* { context.createIndexBuffer(6, usage).dispose(); });
      }
      var dynamic:VertexBuffer3D = context.createVertexBuffer(4, 4, "dynamicDraw");
      dynamic.uploadFromVector(Vector.<Number>([-1, -1, 0, 1, 1, -1, 0, 1, 1, 1, 0, 1, -1, 1, 0, 1]), 0, 4);
      var dynamicIndices:IndexBuffer3D = context.createIndexBuffer(6, "dynamicDraw");
      dynamicIndices.uploadFromVector(Vector.<uint>([0, 1, 2, 0, 2, 3]), 0, 6);
      context.setVertexBufferAt(0, dynamic, 0, "float4");
      context.setProgram(flat);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0, 1, 0, 1]));
      context.clear(0, 0, 0, 1);
      context.drawTriangles(dynamicIndices);
      trace("contextarguments dynamic-draw", pixel());
      dynamic.uploadFromVector(Vector.<Number>([-1, -1, 0, 1, 0, -1, 0, 1, 0, 0, 0, 1, -1, 0, 0, 1]), 0, 4);
      context.clear(0, 0, 0, 1);
      context.drawTriangles(dynamicIndices);
      trace("contextarguments dynamic-redraw", pixel());
      context.setVertexBufferAt(0, vertices, 0, "float4");
      dynamic.dispose();
      dynamicIndices.dispose();
      for each (var index:int in [7, 8, 9, 15, 16, 100, -1]) {
        probe("vertexat " + index, function():* { context.setVertexBufferAt(index, vertices, 0, "float4"); });
        probe("vertexat-null " + index, function():* { context.setVertexBufferAt(index, null); });
      }
      for each (var type:* in ["vertex", "fragment", "bogus", "", null, "Vertex"]) {
        probe("constants " + type, function():* { context.setProgramConstantsFromVector(type, 0, Vector.<Number>([1, 2, 3, 4])); });
        var bytes:ByteArray = new ByteArray();
        bytes.endian = "littleEndian";
        for (var i:int = 0; i < 8; i++) { bytes.writeFloat(i); }
        probe("bytes " + type, function():* { context.setProgramConstantsFromByteArray(type, 0, 2, bytes, 0); });
      }
      var data:ByteArray = new ByteArray();
      data.endian = "littleEndian";
      for (var j:int = 0; j < 8; j++) { data.writeFloat(j); }
      probe("bytes-offset", function():* { context.setProgramConstantsFromByteArray("vertex", 0, 1, data, 16); });
      probe("bytes-offset-over", function():* { context.setProgramConstantsFromByteArray("vertex", 0, 2, data, 4); });
      probe("bytes-offset-end", function():* { context.setProgramConstantsFromByteArray("vertex", 0, 1, data, 32); });
      probe("bytes-count0", function():* { context.setProgramConstantsFromByteArray("vertex", 0, 0, data, 0); });
      probe("bytes-countneg", function():* { context.setProgramConstantsFromByteArray("vertex", 0, -1, data, 0); });
      probe("bytes-null", function():* { context.setProgramConstantsFromByteArray("vertex", 0, 1, null, 0); });
      probe("bytes-first-neg", function():* { context.setProgramConstantsFromByteArray("vertex", -1, 1, data, 0); });
      probe("bytes-first-127", function():* { context.setProgramConstantsFromByteArray("vertex", 127, 1, data, 0); });
      probe("bytes-first-127-2", function():* { context.setProgramConstantsFromByteArray("vertex", 127, 2, data, 0); });
      probe("bytes-frag-27", function():* { context.setProgramConstantsFromByteArray("fragment", 27, 1, data, 0); });
      probe("bytes-frag-28", function():* { context.setProgramConstantsFromByteArray("fragment", 28, 1, data, 0); });
      probe("vector-first-127-2", function():* { context.setProgramConstantsFromVector("vertex", 127, Vector.<Number>([1, 2, 3, 4, 5, 6, 7, 8])); });
      // A constant from bytes, drawn.
      context.setProgram(flat);
      var color:ByteArray = new ByteArray();
      color.endian = "littleEndian";
      color.writeFloat(9); color.writeFloat(0); color.writeFloat(0); color.writeFloat(1); color.writeFloat(1);
      context.setProgramConstantsFromByteArray("fragment", 0, 1, color, 4);
      context.clear(0, 0, 0, 1);
      context.drawTriangles(indices);
      trace("contextarguments bytes-draw", pixel());
      color.endian = "bigEndian";
      color.position = 0;
      color.writeFloat(1); color.writeFloat(0); color.writeFloat(1); color.writeFloat(1);
      context.setProgramConstantsFromByteArray("fragment", 0, 1, color, 0);
      context.clear(0, 0, 0, 1);
      context.drawTriangles(indices);
      trace("contextarguments bytes-big-endian", pixel(), color.position);
    }

    private function textured(mip:uint):Program3D {
      var v:ByteArray = header(false);
      emit(v, 0, 0x030f0000, 0xe4000000, 0);
      emit(v, 0, 0x040f0000, 0xe4000001, 0);
      var f:ByteArray = header(true);
      emit(f, 0x28, 0x020f0000, 0xe4000000, 4, 0, mip | 5);
      emit(f, 0, 0x030f0000, 0xe4000000, 2);
      var p:Program3D = context.createProgram();
      p.upload(v, f);
      return p;
    }

    private function level(size:int, color:uint):BitmapData {
      return new BitmapData(size, size, true, color);
    }

    private function streaming():void {
      for each (var n:int in [-1, 0, 1, 3, 4, 5, 100]) {
        probe("tex-streaming " + n, function():* { context.createTexture(8, 8, "bgra", false, n).dispose(); });
        probe("tex-streaming-rtt " + n, function():* { context.createTexture(8, 8, "bgra", true, n).dispose(); });
        probe("tex-streaming-dxt " + n, function():* { context.createTexture(8, 8, "compressed", false, n).dispose(); });
        probe("cube-streaming " + n, function():* { context.createCubeTexture(8, "bgra", false, n).dispose(); });
      }
      probe("tex-streaming-wide 3", function():* { context.createTexture(16, 4, "bgra", false, 3).dispose(); });
      probe("tex-streaming-wide 4", function():* { context.createTexture(16, 4, "bgra", false, 4).dispose(); });
      probe("tex-streaming-wide 5", function():* { context.createTexture(16, 4, "bgra", false, 5).dispose(); });
      context.setVertexBufferAt(1, vertices, 4, "float2");
      var mips:Array = [["mipnone", 0], ["mipnearest", 0x01000000], ["miplinear", 0x02000000]];
      for each (var mip:Array in mips) {
        var program:Program3D = textured(mip[1]);
        context.setProgram(program);
        var texture:Texture = context.createTexture(8, 8, "bgra", false, 2);
        context.setTextureAt(0, texture);
        var draw:Function = function(label:String):void {
          context.clear(0, 0, 0, 1);
          try { context.drawTriangles(indices); trace("contextarguments", mip[0], label, pixel()); }
          catch (error:Error) { trace("contextarguments", mip[0], label, error.name, error.errorID); }
        };
        draw("none");
        texture.uploadFromBitmapData(level(1, 0xff0000ff), 3);
        draw("level3");
        texture.uploadFromBitmapData(level(2, 0xff00ff00), 2);
        draw("level2");
        texture.uploadFromBitmapData(level(4, 0xffff0000), 1);
        draw("level1");
        texture.uploadFromBitmapData(level(8, 0xffffffff), 0);
        draw("level0");
        texture.dispose();
        texture = context.createTexture(8, 8, "bgra", false, 2);
        context.setTextureAt(0, texture);
        texture.uploadFromBitmapData(level(2, 0xff00ff00), 2);
        draw("only2");
        texture.uploadFromBitmapData(level(8, 0xffffffff), 0);
        draw("only2and0");
        texture.uploadFromBitmapData(level(1, 0xff0000ff), 3);
        draw("2-0-3");
        texture.dispose();
        texture = context.createTexture(8, 8, "bgra", false, 1);
        context.setTextureAt(0, texture);
        texture.uploadFromBitmapData(level(4, 0xffff0000), 1);
        texture.uploadFromBitmapData(level(2, 0xff00ff00), 2);
        texture.uploadFromBitmapData(level(1, 0xff0000ff), 3);
        draw("s1-123");
        texture.dispose();
        texture = context.createTexture(8, 8, "bgra", false, 3);
        context.setTextureAt(0, texture);
        texture.uploadFromBitmapData(level(1, 0xff0000ff), 3);
        draw("s3-3");
        texture.dispose();
        texture = context.createTexture(8, 8, "bgra", false, 0);
        context.setTextureAt(0, texture);
        texture.uploadFromBitmapData(level(8, 0xffffffff), 0);
        draw("s0-0");
        texture.dispose();
        context.setTextureAt(0, null);
        program.dispose();
      }
      context.setVertexBufferAt(1, null);
      cubes();
    }

    /** A cube texture streams as a 2D one does, all six faces at each level. */
    private function cubes():void {
      var v:ByteArray = header(false);
      emit(v, 0, 0x030f0000, 0xe4000000, 0);
      emit(v, 0, 0x040f0000, 0xe4000000, 0);
      var mips:Array = [["mipnone", 0], ["mipnearest", 0x01000000]];
      for each (var mip:Array in mips) {
        var f:ByteArray = header(true);
        emit(f, 0x28, 0x020f0000, 0xe4000000, 4, 0, mip[1] | 0x1000 | 5);
        emit(f, 0, 0x030f0000, 0xe4000000, 2);
        var program:Program3D = context.createProgram();
        program.upload(v, f);
        context.setProgram(program);
        var cube:CubeTexture = context.createCubeTexture(8, "bgra", false, 2);
        context.setTextureAt(0, cube);
        var draw:Function = function(label:String):void {
          context.clear(0, 0, 0, 1);
          try { context.drawTriangles(indices); trace("contextarguments cube", mip[0], label, pixel()); }
          catch (error:Error) { trace("contextarguments cube", mip[0], label, error.name, error.errorID); }
        };
        var face:int;
        for (face = 0; face < 6; face++) { cube.uploadFromBitmapData(level(1, 0xff0000ff), face, 3); }
        draw("level3");
        for (face = 0; face < 6; face++) { cube.uploadFromBitmapData(level(2, 0xff00ff00), face, 2); }
        draw("level2");
        cube.uploadFromBitmapData(level(4, 0xffff0000), 0, 1);
        draw("level1-one-face");
        for (face = 1; face < 6; face++) { cube.uploadFromBitmapData(level(4, 0xffff0000), face, 1); }
        draw("level1");
        for (face = 0; face < 6; face++) { cube.uploadFromBitmapData(level(8, 0xffffffff), face, 0); }
        draw("level0");
        cube.dispose();
        context.setTextureAt(0, null);
        program.dispose();
      }
    }

    private function run():void {
      masks();
      buffers();
      streaming();
    }
  }
}
