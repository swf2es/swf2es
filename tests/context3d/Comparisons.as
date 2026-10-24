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

  // Check the AGAL comparison rules independently of the shader translator.
  // Wine's legacy GL backend misrenders AIR's fragment comparisons and vertex seq.
  public class Comparisons extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;
    private var checks:int = 0;

    public function Comparisons() {
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
        var vertices:VertexBuffer3D = context.createVertexBuffer(3, 4);
        vertices.uploadFromVector(Vector.<Number>([-0.75, -0.75, 0.5, 1,
          0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1]), 0, 3);
        indices = context.createIndexBuffer(3);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        pixels = new BitmapData(64, 64, true, 0);
        run();
        vertices.dispose();
        indices.dispose();
        pixels.dispose();
        context.dispose(false);
        complete = true;
        trace("comparisons checks", checks);
        trace("comparisons complete");
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

    private function emit(bytes:ByteArray, op:uint, dest:uint, a:uint, at:uint,
      b:uint = 0, bt:uint = 0):void {
      bytes.writeUnsignedInt(op);
      bytes.writeUnsignedInt(dest);
      bytes.writeUnsignedInt(a);
      bytes.writeUnsignedInt(at);
      bytes.writeUnsignedInt(b);
      bytes.writeUnsignedInt(bt);
    }

    private function compare(op:uint, a:Number, b:Number):uint {
      switch (op) {
        case 0x29: return a >= b ? 255 : 0;
        case 0x2a: return a < b ? 255 : 0;
        case 0x2c: return a == b ? 255 : 0;
        default: throw new Error("Unexpected comparison opcode");
      }
    }

    private function checkPixel(label:String, x:int, y:int, expected:uint):void {
      var actual:uint = pixels.getPixel32(x, y);
      if (actual != expected) {
        throw new Error(label + " at " + x + "," + y + ": " + actual.toString(16)
          + " != " + expected.toString(16));
      }
      checks++;
    }

    private function draw(vertex:ByteArray, fragment:ByteArray):void {
      var program:Program3D = context.createProgram();
      program.upload(vertex, fragment);
      context.setProgram(program);
      context.clear(0, 0, 1, 1);
      context.drawTriangles(indices);
      context.drawToBitmapData(pixels);
      program.dispose();
    }

    private function run():void {
      var inputs:Array = [[-1, 0, 1, 0.5], [0.5, 0.5, 0.5, 0.5], [-0.0, 0.0, -1, 1],
        [1, 1 + 1 / 8388608, -1, -1 - 1 / 8388608]];
      var others:Array = [[0, 0, 0, 0.5], [0.5, 0.5, 0.5, 0.5], [0.0, -0.0, 1, -1],
        [1, 1, -1, -1]];
      var masks:Array = [15, 1, 2, 4, 8, 5];
      var swizzles:Array = [0xe4, 0x1b];
      var ops:Array = [0x29, 0x2a, 0x2c];
      for (var stageIndex:int = 0; stageIndex < 2; stageIndex++) {
        var stageName:String = stageIndex == 0 ? "vertex" : "fragment";
        for (var input:int = 0; input < inputs.length; input++) {
          context.setProgramConstantsFromVector(stageName, 0, Vector.<Number>(inputs[input]));
          context.setProgramConstantsFromVector(stageName, 1, Vector.<Number>(others[input]));
          context.setProgramConstantsFromVector(stageName, 2, Vector.<Number>([0, 0, 0, 1]));
          for (var o:int = 0; o < ops.length; o++) {
            var op:int = ops[o];
            for (var m:int = 0; m < masks.length; m++) {
              for (var s:int = 0; s < swizzles.length; s++) {
                for (var dest:int = 0; dest < 3; dest++) {
                  var vertex:ByteArray = header(false);
                  emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
                  var fragment:ByteArray = header(true);
                  var math:ByteArray = stageIndex == 0 ? vertex : fragment;
                  emit(math, 0, 0x020f0000, 0xe4000000, 1);
                  emit(math, 0, 0x020f0001, 0xe4000001, 1);
                  emit(math, 0, 0x020f0002, 0xe4000002, 1);
                  emit(math, op, 0x02000000 | (masks[m] << 16) | dest,
                    swizzles[s] << 24, 2, (swizzles[1 - s] << 24) | 1, 2);
                  // Read each written lane as RGB so alpha conversion cannot hide a failure.
                  for (var lane:int = 0; lane < 4; lane++) {
                    if (!(masks[m] & (1 << lane))) { continue; }
                    var output:ByteArray = new ByteArray();
                    output.endian = "littleEndian";
                    output.writeBytes(math);
                    emit(output, 0, 0x020f0003, 0xe4000002, 1);
                    emit(output, 0, 0x02070003, ((lane * 0x55) << 24) | dest, 2);
                    emit(output, 0, stageIndex == 0 ? 0x040f0000 : 0x030f0000,
                      0xe4000003, 2);
                    if (stageIndex == 0) {
                      var pass:ByteArray = header(true);
                      emit(pass, 0, 0x030f0000, 0xe4000000, 4);
                      draw(output, pass);
                    } else {
                      draw(vertex, output);
                    }
                    var a:Number = inputs[input][(swizzles[s] >>> (lane * 2)) & 3];
                    var b:Number = others[input][(swizzles[1 - s] >>> (lane * 2)) & 3];
                    var color:uint = 0xff000000 | (compare(op, a, b) * 0x010101);
                    checkPixel(stageName + "-" + input + "-" + op + "-" + masks[m] + "-" + s + "-" + dest
                      + "-" + lane, 32, 32, color);
                  }
                }
              }
            }
          }
        }
      }
      // Interpolated inputs exercise the per-fragment decision used by shadow maps.
      for (o = 0; o < ops.length; o++) {
        op = ops[o];
        vertex = header(false);
        emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
        emit(vertex, 0, 0x040f0000, 0xe4000000, 0);
        fragment = header(true);
        context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0, 0, 0.5, 1]));
        emit(fragment, op, 0x020f0000, 0xe4000000, 4, 0xe4000000, 1);
        emit(fragment, 0, 0x020f0001, 0xe4000002, 1);
        emit(fragment, 0, 0x02070001, 0xe4000000, 2);
        emit(fragment, 0, 0x030f0000, 0xe4000001, 2);
        draw(vertex, fragment);
        var points:Array = [[22, 36], [42, 36], [30, 22], [34, 22]];
        for (var point:int = 0; point < points.length; point++) {
          var x:int = points[point][0];
          var y:int = points[point][1];
          color = 0xff000000 | (compare(op, (x + 0.5) / 32 - 1, 0) << 16)
            | (compare(op, 1 - (y + 0.5) / 32, 0) << 8) | compare(op, 0.5, 0.5);
          checkPixel("varying-" + op, x, y, color);
        }
      }
    }
  }
}
