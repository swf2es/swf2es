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

  public class IndirectConstants extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;
    private var address:VertexBuffer3D;

    public function IndirectConstants() {
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
        vertices = context.createVertexBuffer(3, 4);
        vertices.uploadFromVector(Vector.<Number>([
          -0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1
        ]), 0, 3);
        indices = context.createIndexBuffer(3);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        context.setCulling("none");
        pixels = new BitmapData(64, 64, true, 0);
        run();
        vertices.dispose();
        indices.dispose();
        pixels.dispose();
        context.dispose(false);
        complete = true;
        trace("indirectconstants complete");
      });
      slot.requestContext3D("auto", "baseline");
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

    private function draw(label:String, vertex:ByteArray, fragment:ByteArray):void {
      var program:Program3D = context.createProgram();
      program.upload(vertex, fragment);
      context.setProgram(program);
      context.clear(0, 0, 0, 1);
      context.drawTriangles(indices);
      context.drawToBitmapData(pixels);
      trace("indirectconstants", label, pixels.getPixel32(32, 32).toString(16),
        pixels.getPixel32(22, 36).toString(16), pixels.getPixel32(42, 36).toString(16));
      program.dispose();
    }

    private function probe(label:String, type:int, lane:int, value:Number, offset:int = 0,
        swizzle:uint = 0xe4, mask:uint = 15, op:uint = 0, overlap:Boolean = false, varyIndex:Boolean = false):void {
      var values:Vector.<Number> = Vector.<Number>([11, 22, 33, 44]);
      values[lane] = value;
      context.setProgramConstantsFromVector("vertex", 120, values);
      var attributes:Vector.<Number> = values.concat(values, values);
      if (varyIndex) {
        attributes[4 + lane]++;
        attributes[8 + lane] += 2;
      }

      address.uploadFromVector(attributes, 0, 3);
      context.setVertexBufferAt(7, type == 0 ? address : null, 0, "float4");
      var vertex:ByteArray = header(false);
      emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
      emit(vertex, 0, 0x020f0000, 0xe400007a, 1);
      emit(vertex, 0, 0x020f0006, 0xe4000079, 1);
      emit(vertex, 0, 0x020f0007, 0xe4000078, 1);
      var index:uint = type == 1 ? 120 : 7;
      var low:uint = (swizzle << 24) | (offset << 16) | index;
      var high:uint = 0x80000001 | (lane << 16) | (type << 8);
      var dest:uint = 0x02000000 | (mask << 16) | (overlap ? 7 : 0);
      if (op == 0) {
        emit(vertex, op, dest, low, high);
      } else {
        emit(vertex, op, dest, 0xe4000006, 2, low, high);
      }
      emit(vertex, 0, 0x040f0000, 0xe4000000 | (overlap ? 7 : 0), 2);
      var fragment:ByteArray = header(true);
      emit(fragment, 0, 0x030f0000, 0xe4000000, 4);
      draw(label, vertex, fragment);
    }

    private function run():void {
      var bank:Vector.<Number> = new Vector.<Number>();
      for (var i:int = 0; i < 128; i++) {
        bank.push((i % 16) / 16, ((i * 3 + 1) % 16) / 16, ((i * 7 + 2) % 16) / 16, 1);
      }

      context.setProgramConstantsFromVector("vertex", 0, bank);
      context.setProgramConstantsFromVector("vertex", 121, Vector.<Number>([0.125, 0.25, 0.5, 0.125]));
      context.setProgramConstantsFromVector("vertex", 122, Vector.<Number>([0.0625, 0.125, 0.1875, 1]));
      address = context.createVertexBuffer(3, 4);
      context.setVertexBufferAt(7, address, 0, "float4");

      for (var type:int = 0; type < 3; type++) {
        for (var lane:int = 0; lane < 4; lane++) {
          probe("lane-" + type + "-" + lane, type, lane, 5);
          probe("offset-" + type + "-" + lane, type, lane, 5, 4);
          probe("swizzle-" + type + "-" + lane, type, lane, 5, 4, 0xc6);
          probe("mask-" + type + "-" + lane, type, lane, 5, 4, 0xc6, 5);
          probe("second-" + type + "-" + lane, type, lane, 5, 4, 0xc6, 15, 3);
          probe("overlap-" + type + "-" + lane, type, lane, 5, 4, 0xe4, 15, 0, true);
        }
      }

      for (lane = 0; lane < 4; lane++) {
        probe("per-vertex-" + lane, 0, lane, 3, 0, 0xe4, 15, 0, false, true);
      }

      // The reference D3D backend rounds ties to even before adding the offset.
      var values:Array = [-2, -1.5, -0.51, -0.5, 0, 0.49, 0.5, 0.51, 1.5, 2.5, 3.5, 126, 127, 127.5, 128];
      for (i = 0; i < values.length; i++) {
        probe("round-" + values[i], 0, 2, values[i]);
        probe("round-offset-" + values[i], 2, 1, values[i], 3);
      }

      probe("last-offset", 1, 3, 0, 127);
      for (type = 0; type < 3; type++) {
        for (var op:uint = 0x17; op <= 0x19; op++) {
          for (var partial:int = 0; partial < (op == 0x18 ? 2 : 1); partial++) {
            var mask:uint = partial ? 5 : op == 0x18 ? 15 : 7;
            probe("matrix-" + type + "-" + op + "-" + partial, type, 2, 4, 3, 0xe4, mask, op);
            probe("matrix-overlap-" + type + "-" + op + "-" + partial, type, 2, 4, 3, 0xe4, mask, op, true);
            probe("matrix-end-" + type + "-" + op + "-" + partial, type, 2, 126, 0, 0xe4, mask, op);
            probe("matrix-offset-end-" + type + "-" + op + "-" + partial, type, 2, 0, 126, 0xe4, mask, op);
          }
        }
      }

      address.dispose();
    }
  }
}
