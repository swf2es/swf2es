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

  public class BufferBytes extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var program:Program3D;
    private var pixels:BitmapData;

    public function BufferBytes() {
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
        vertices = context.createVertexBuffer(6, 4);
        vertices.uploadFromVector(Vector.<Number>([-0.8, -0.8, 0, 1, 0.8, -0.8, 0, 1, 0, 0.8, 0, 1]), 0, 3);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 0, 2, 1]), 0, 6);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        program = context.createProgram();
        program.upload(shader(false), shader(true));
        context.setProgram(program);
        pixels = new BitmapData(64, 64, true, 0);
        run();
        context.dispose(false);

        vertices.dispose();
        indices.dispose();
        program.dispose();
        pixels.dispose();
        complete = true;
        trace("bufferbytes complete");
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

    private function draw(r:Number = 1, g:Number = 0, b:Number = 0, a:Number = 1, first:int = 0):void {
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([r, g, b, a]));
      context.drawTriangles(indices, first, 1);
    }

    private function probe(label:String, action:Function):void {
      try { action(); trace("bufferbytes", label, "accepted"); }
      catch (error:Error) { trace("bufferbytes", label, error.name, error.errorID); }
    }

    private function vertexBytes(prefix:int):ByteArray {
      var data:ByteArray = new ByteArray();
      data.endian = "littleEndian";
      for (var i:int = 0; i < prefix; i++) { data.writeByte(0xa5); }
      var values:Array = [-0.8, -0.8, 0, 1, 0.8, -0.8, 0, 1, 0, 0.8, 0, 1];
      for (i = 0; i < values.length; i++) { data.writeFloat(values[i]); }
      return data;
    }

    private function indexBytes(prefix:int):ByteArray {
      var data:ByteArray = new ByteArray();
      data.endian = "littleEndian";
      for (var i:int = 0; i < prefix; i++) { data.writeByte(0xa5); }
      data.writeShort(3); data.writeShort(4); data.writeShort(5);
      return data;
    }

    private function capture(label:String):void {
      context.clear(0, 0, 1, 1);
      draw();
      context.drawToBitmapData(pixels);
      trace("bufferbytes", label, pixels.getPixel32(16, 32).toString(16),
        pixels.getPixel32(32, 32).toString(16), pixels.getPixel32(48, 32).toString(16));
    }

    private function errors(label:String, target:Object, data:ByteArray):void {
      var offsets:Array = [-1, 0, data.length, data.length + 1];
      var starts:Array = [-1, 0, 6, 7];
      var counts:Array = [-1, 0, 1, 7];
      for (var o:int = 0; o < offsets.length; o++) {
        for (var s:int = 0; s < starts.length; s++) {
          for (var n:int = 0; n < counts.length; n++) {
            var name:String = label + "-" + offsets[o] + "-" + starts[s] + "-" + counts[n];
            probe(name, function():void { target.uploadFromByteArray(data, offsets[o], starts[s], counts[n]); });
          }
        }
      }
      probe(label + "-null", function():void { target.uploadFromByteArray(null, 0, 0, 1); });
      probe(label + "-null-invalid", function():void { target.uploadFromByteArray(null, -1, -1, -1); });
      var empty:ByteArray = new ByteArray();
      probe(label + "-empty-zero", function():void { target.uploadFromByteArray(empty, 0, 0, 0); });
    }

    private function run():void {
      context.setDepthTest(false, "always");
      for (var offset:int = 0; offset < 8; offset++) {
        for (var endian:int = 0; endian < 2; endian++) {
          var vb:ByteArray = vertexBytes(offset);
          var ib:ByteArray = indexBytes(offset);
          vb.endian = ib.endian = endian ? "bigEndian" : "littleEndian";
          vb.position = 7; ib.position = 2;
          vertices.uploadFromByteArray(vb, offset, 3, 3);
          indices.uploadFromByteArray(ib, offset, 0, 3);
          capture("offset-" + offset + "-" + endian);
          trace("bufferbytes source", vb.position, vb.length, vb.endian, ib.position, ib.length, ib.endian);
          // Uploads must snapshot the bytes, without retaining their storage.
          vb.clear(); ib.clear();
          capture("source-cleared-" + offset + "-" + endian);
        }
      }
      vb = vertexBytes(3); ib = indexBytes(1);
      vertices.uploadFromByteArray(vb, 3, 4, 1);
      capture("partial-vertex");
      vertices.uploadFromByteArray(vb, 19, 4, 1);
      capture("restore-vertex");
      indices.uploadFromByteArray(ib, 1, 1, 1);
      capture("partial-index");
      indices.uploadFromByteArray(ib, 3, 1, 1);
      capture("restore-index");
      indices.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
      capture("vector-after-bytes");
      vertices.uploadFromByteArray(vb, 3, 0, 3);
      capture("bytes-after-vector");

      // Shrink a previously large allocation: capacity is not readable data.
      vb.length = 3;
      ib.length = 1;
      probe("vertex-short", function():void { vertices.uploadFromByteArray(vb, 0, 0, 1); });
      probe("index-short", function():void { indices.uploadFromByteArray(ib, 0, 0, 1); });
      capture("failed-upload-preserves");
      vb = vertexBytes(0); ib = indexBytes(0);
      errors("vertex", vertices, vb);
      errors("index", indices, ib);
      vertices.dispose(); indices.dispose();
      probe("vertex-disposed", function():void { vertices.uploadFromByteArray(vb, 0, 0, 1); });
      probe("index-disposed", function():void { indices.uploadFromByteArray(ib, 0, 0, 1); });
      errors("retired-vertex", vertices, vb);
      errors("retired-index", indices, ib);
      probe("disposed-null", function():void { vertices.uploadFromByteArray(null, -1, -1, -1); });
      var retired:VertexBuffer3D = vertices;
      vertices = context.createVertexBuffer(3, 4);
      indices = context.createIndexBuffer(3);
      context.dispose(false);
      probe("retired-owner-disposed", function():void { retired.uploadFromByteArray(vb, 0, 0, 1); });
      probe("owner-disposed-vertex", function():void { vertices.uploadFromByteArray(vb, 0, 0, 1); });
      probe("owner-disposed-null", function():void { vertices.uploadFromByteArray(null, -1, -1, -1); });
      probe("owner-disposed-invalid", function():void { vertices.uploadFromByteArray(vb, -1, -1, -1); });
      probe("owner-disposed-index", function():void { indices.uploadFromByteArray(ib, 0, 0, 1); });
    }
  }
}
