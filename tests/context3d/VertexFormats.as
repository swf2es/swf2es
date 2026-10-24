package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class VertexFormats extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var program:Program3D;
    private var pixels:BitmapData;

    public function VertexFormats() {
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
        vertices = context.createVertexBuffer(4, 5);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 2, 1, 3]), 0, 6);
        program = context.createProgram();
        pixels = new BitmapData(64, 64, true, 0);
        context.setCulling("none");
        run();
        vertices.dispose(); indices.dispose(); program.dispose(); pixels.dispose();
        context.dispose(false);
        complete = true;
        trace("vertexformats complete");
      });
      slot.requestContext3D("auto", "baseline");
    }

    private function header(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0); bytes.writeUnsignedInt(1); bytes.writeByte(0xa1);
      bytes.writeByte(fragment ? 1 : 0);
      return bytes;
    }

    private function emit(bytes:ByteArray, dest:uint, source:uint, type:uint):void {
      bytes.writeUnsignedInt(0); bytes.writeUnsignedInt(dest);
      bytes.writeUnsignedInt(source); bytes.writeUnsignedInt(type);
      bytes.writeUnsignedInt(0); bytes.writeUnsignedInt(0);
    }

    private function shaders(swizzle:uint = 0xe4, opaque:Boolean = true):void {
      var vertex:ByteArray = header(false);
      emit(vertex, 0x030f0000, 0xe4000000, 0);
      emit(vertex, 0x040f0000, (swizzle << 24) | 1, 0);
      var fragment:ByteArray = header(true);
      emit(fragment, 0x020f0000, 0xe4000000, 4);
      if (opaque) { emit(fragment, 0x02080000, 0xff000000, 1); }
      emit(fragment, 0x030f0000, 0xe4000000, 2);
      program.upload(vertex, fragment);
      context.setProgram(program);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0,0,0,1]));
    }

    private function dataFor(colors:Array, prefix:int = 0):ByteArray {
      var data:ByteArray = new ByteArray();
      data.endian = "littleEndian";
      for (var i:int = 0; i < prefix; i++) { data.writeByte(0xa5); }
      var xy:Array = [-1,1, 1,1, -1,-1, 1,-1];
      for (i = 0; i < 4; i++) {
        data.writeFloat(xy[i*2]); data.writeFloat(xy[i*2+1]);
        data.writeFloat(0.5); data.writeFloat(1);
        for (var lane:int = 0; lane < 4; lane++) { data.writeByte(colors[(i*4+lane) % colors.length]); }
      }
      return data;
    }

    private function capture(label:String):void {
      context.clear(0,0,0,1);
      try { context.drawTriangles(indices); }
      catch (error:Error) { trace("vertexformats", label, error.name, error.errorID); return; }
      context.drawToBitmapData(pixels);
      trace("vertexformats", label, pixels.getPixel32(16,16).toString(16),
        pixels.getPixel32(48,16).toString(16), pixels.getPixel32(16,48).toString(16),
        pixels.getPixel32(48,48).toString(16));
    }

    private function probe(label:String, action:Function):void {
      try { action(); trace("vertexformats", label, "accepted"); }
      catch (error:Error) { trace("vertexformats", label, error.name, error.errorID); }
    }

    private function bindings(label:String, target:VertexBuffer3D):void {
      var slots:Array = [-1, 0, 7];
      var offsets:Array = [-1, 0, 4, 5, 6];
      var formats:Array = ["bytes4", "float1", "float4", "bad", null];
      for (var i:int = 0; i < slots.length; i++) {
        for (var o:int = 0; o < offsets.length; o++) {
          for (var f:int = 0; f < formats.length; f++) {
            var name:String = label + "-" + slots[i] + "-" + offsets[o] + "-" + formats[f];
            probe(name, function():void { context.setVertexBufferAt(slots[i], target, offsets[o], formats[f]); });
          }
        }
      }
    }

    private function run():void {
      context.setVertexBufferAt(0, vertices, 0, "float4");
      context.setVertexBufferAt(1, vertices, 4, "bytes4");
      shaders();
      for (var value:int = 0; value < 256; value++) {
        var data:ByteArray = dataFor([value, 255-value, value ^ 128, 255], 3);
        vertices.uploadFromByteArray(data, 3, 0, 4);
        data.clear();
        capture("byte" + value);
      }
      var colors:Array = [17, 65, 129, 193];
      data = dataFor(colors, 1);
      vertices.uploadFromByteArray(data, 1, 0, 4);
      shaders(0x1b); capture("swizzled");
      shaders(0xff); capture("alpha-lane");
      shaders(0xe4, false); capture("alpha");
      shaders();
      var stream:VertexBuffer3D = context.createVertexBuffer(4, 1);
      var packed:ByteArray = new ByteArray();
      for (var i:int = 0; i < 4; i++) {
        for (var j:int = 0; j < 4; j++) { packed.writeByte(colors[j]); }
      }
      stream.uploadFromByteArray(packed, 0, 0, 4);
      context.setVertexBufferAt(1, stream, 0, "bytes4"); capture("separate-stream");
      // Draw as floats before reinterpreting: see the AIR backend discrepancy in README.
      stream.uploadFromVector(Vector.<Number>([1,1,1,1]), 0, 4);
      context.setVertexBufferAt(1, stream, 0, "float1"); capture("float1");
      context.setVertexBufferAt(1, stream, 0, "bytes4"); capture("bytes-again");
      stream.dispose();
      context.setVertexBufferAt(1, vertices, 4, "bytes4");
      probe("invalid-offset", function():void { context.setVertexBufferAt(1, vertices, 5, "bytes4"); });
      capture("invalid-offset-draw");
      context.setVertexBufferAt(1, vertices, 4, "bytes4"); capture("restored");
      for (var offset:int = -1; offset <= 6; offset++) {
        for (var size:int = 1; size <= 4; size++) {
          context.setVertexBufferAt(1, vertices, offset, "float" + size);
          capture("offset" + offset + "-float" + size);
        }
        context.setVertexBufferAt(1, vertices, offset, "bytes4");
        capture("offset" + offset + "-bytes4");
      }
      bindings("live", vertices);
      bindings("null", null);
      vertices.dispose(); bindings("disposed-buffer", vertices);
      context.dispose(false); bindings("disposed-context", vertices);
      bindings("disposed-context-null", null);
    }
  }
}
