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

  public class TemporaryMatrices extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;

    public function TemporaryMatrices() {
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
        trace("temporarymatrices complete");
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
      trace("temporarymatrices", label, pixels.getPixel32(32, 32).toString(16),
        pixels.getPixel32(22, 36).toString(16), pixels.getPixel32(42, 36).toString(16));
      program.dispose();
    }

    private function run():void {
      var values:Vector.<Number> = Vector.<Number>([0.25, 0.5, 0.75, 1]);
      var rows:Vector.<Number> = Vector.<Number>([
        0, 0.5, 0, 0.125, 0.25, 0, 0, 0.25,
        0, 0, 0.5, 0.125, 0.125, 0.25, 0, 0.5
      ]);
      context.setProgramConstantsFromVector("vertex", 0, values);
      context.setProgramConstantsFromVector("fragment", 0, values);
      context.setProgramConstantsFromVector("vertex", 4, rows);
      context.setProgramConstantsFromVector("fragment", 4, rows);
      var destinations:Array = [0, 1, 3, 7];
      for (var stageIndex:int = 0; stageIndex < 2; stageIndex++) {
        for (var op:uint = 0x17; op <= 0x19; op++) {
          for (var i:int = 0; i < destinations.length; i++) {
            for (var partial:int = 0; partial < 2; partial++) {
              var dest:uint = destinations[i];
              var code:ByteArray = header(stageIndex == 1);
              emit(code, 0, 0x020f0000, 0xe4000000, 1);
              for (var row:int = 0; row < 4; row++) {
                emit(code, 0, 0x020f0001 + row, 0xe4000004 + row, 1);
              }
              emit(code, 0, 0x020f0007, 0xe4000000, 1);
              var mask:uint = op == 0x18 ? (partial ? 5 : 15) : 7;
              emit(code, op, 0x02000000 | (mask << 16) | dest, partial ? 0xc6000000 : 0xe4000000, 2, 0xe4000001, 2);
              var vertex:ByteArray;
              var fragment:ByteArray;
              if (stageIndex == 0) {
                emit(code, 0, 0x040f0000, 0xe4000000 | dest, 2);
                emit(code, 0, 0x030f0000, 0xe4000000, 0);
                vertex = code;
                fragment = header(true);
                emit(fragment, 0, 0x030f0000, 0xe4000000, 4);
              } else {
                emit(code, 0, 0x030f0000, 0xe4000000 | dest, 2);
                fragment = code;
                vertex = header(false);
                emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
              }
              draw(stageIndex + "-" + op + "-" + dest + "-" + partial, vertex, fragment);
            }
          }
        }
      }
    }
  }
}
