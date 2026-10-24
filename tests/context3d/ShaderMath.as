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

  public class ShaderMath extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;

    public function ShaderMath() {
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
        vertices.uploadFromVector(Vector.<Number>([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1]), 0, 3);
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
        trace("shadermath complete");
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
      context.clear(0, 0, 1, 1);
      context.drawTriangles(indices);
      context.drawToBitmapData(pixels);
      trace("shadermath", label, pixels.getPixel32(32, 32).toString(16),
        pixels.getPixel32(22, 36).toString(16), pixels.getPixel32(42, 36).toString(16));
      program.dispose();
    }

    private function run():void {
      var ops:Array = [8, 9, 0x0a, 0x0b, 0x0e, 0x11, 0x29, 0x2a];
      var inputs:Array = [
        [-1.25, -0.5, 1.75, 1], [0.0625, 0.25, 0.5625, 1],
        [1, 4, 16, 1], [0.25, 0.5, 0.75, 1],
        [0, 3, 4, 1], [1, 0, 0, 1], [-1, 0, 1, 1], [-1, 0, 1, 1]
      ];
      for (var stageIndex:int = 0; stageIndex < 2; stageIndex++) {
        var stageName:String = stageIndex == 0 ? "vertex" : "fragment";
        context.setProgramConstantsFromVector(stageName, 2, Vector.<Number>([0.5, 0.5, 0.5, 1]));
        for (var i:int = 0; i < ops.length; i++) {
          var op:uint = ops[i];
          if (stageIndex == 1 && (op == 0x29 || op == 0x2a)) { continue; }
          var unary:Boolean = op == 8 || op == 9 || op == 0x0a || op == 0x0e;
          context.setProgramConstantsFromVector(stageName, 0, Vector.<Number>(inputs[i]));
          context.setProgramConstantsFromVector(stageName, 1, op == 0x0b
            ? Vector.<Number>([2, 2, 2, 1]) : op >= 0x29
              ? Vector.<Number>([0, 0, 0, 1]) : Vector.<Number>([0, 1, 0, 1]));
          for (var masked:int = 0; masked < 3; masked++) {
            if (masked == 1 && (op == 0x0e || op == 0x11)) { continue; }
            var vertex:ByteArray = header(false);
            emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
            var fragment:ByteArray = header(true);
            var math:ByteArray = stageIndex == 0 ? vertex : fragment;
            emit(math, 0, 0x020f0000, 0xe4000000, 1);
            // Compare independent destinations with safe overlapping writes.
            emit(math, 0, 0x020f0001, 0xe4000000, 2);
            emit(math, op, masked == 2 ? 0x02070000 : masked == 0 ? 0x02070001 : 0x02020001,
              masked == 2 && (op == 9 || op == 0x0b) ? 0xe4000000 : 0xc6000000, 2,
              unary ? 0 : 0xe4000001, unary ? 0 : 1);
            if (masked != 2) { emit(math, 0, 0x020f0000, 0xe4000001, 2); }
            if (op == 0x11) {
              // Keep negative cross-product components visible in the readback.
              emit(math, 3, 0x02070000, 0xe4000000, 2, 0xe4000002, 1);
              emit(math, 1, 0x02070000, 0xe4000000, 2, 0xe4000002, 1);
            }
            emit(math, 0, stageIndex == 0 ? 0x040f0000 : 0x030f0000, 0xe4000000, 2);
            if (stageIndex == 0) { emit(fragment, 0, 0x030f0000, 0xe4000000, 4); }
            draw(stageName + "-" + op + "-" + masked, vertex, fragment);
          }
        }
      }
      for (stageIndex = 0; stageIndex < 2; stageIndex++) {
        stageName = stageIndex == 0 ? "vertex" : "fragment";
        context.setProgramConstantsFromVector(stageName, 0, Vector.<Number>([0.125, 0.25, 0.5, 0.75]));
        context.setProgramConstantsFromVector(stageName, 1, Vector.<Number>([0.5, 0.5, 0.5, 0.5]));
        for (var scalarOp:int = 0; scalarOp < 2; scalarOp++) {
          op = scalarOp == 0 ? 9 : 0x0b;
          for (var scalarLane:int = 0; scalarLane < 4; scalarLane++) {
            for (var alias:int = 0; alias < (scalarOp == 0 ? 1 : 3); alias++) {
              vertex = header(false);
              emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
              fragment = header(true);
              math = stageIndex == 0 ? vertex : fragment;
              emit(math, 0, 0x020f0000, 0xe4000000, 1);
              var scalar:uint = (scalarLane * 0x55) << 24;
              emit(math, op, 0x02000000 | ((1 << scalarLane) << 16),
                scalar | (alias == 1 ? 1 : 0), alias == 1 ? 1 : 2,
                scalarOp == 0 ? 0 : scalar | (alias == 0 ? 1 : 0),
                scalarOp == 0 ? 0 : alias == 0 ? 1 : 2);
              emit(math, 0, stageIndex == 0 ? 0x040f0000 : 0x030f0000, 0xe4000000, 2);
              if (stageIndex == 0) { emit(fragment, 0, 0x030f0000, 0xe4000000, 4); }
              draw("scalar-" + stageName + "-" + op + "-" + scalarLane + "-" + alias, vertex, fragment);
            }
          }
        }
      }
      vertex = header(false);
      emit(vertex, 0, 0x030f0000, 0xe4000000, 0);

      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 1]));
      var values:Array = [[0, -1, 1, 1], [1, 0, -1, 1], [1, 1, 0, -1], [-1, 1, 1, 0]];
      for (i = 0; i < values.length; i++) {
        context.setProgramConstantsFromVector("fragment", 1, Vector.<Number>(values[i]));
        for (var lane:int = 0; lane < 4; lane++) {
          for (var after:int = 0; after < 2; after++) {
            fragment = header(true);
            if (after == 1) { emit(fragment, 0, 0x030f0000, 0xe4000000, 1); }
            emit(fragment, 0, 0x020f0000, 0xe4000001, 1);
            emit(fragment, 0x27, 0, (lane * 0x55) << 24, 2);
            if (after == 0) { emit(fragment, 0, 0x030f0000, 0xe4000000, 1); }
            draw("discard-" + i + "-" + lane + "-" + after, vertex, fragment);
          }
        }
      }
      emit(vertex, 0, 0x040f0000, 0xe4000000, 0);
      fragment = header(true);
      emit(fragment, 0x27, 0, 0x00000000, 4);
      emit(fragment, 0, 0x030f0000, 0xe4000000, 1);
      draw("discard-varying", vertex, fragment);
    }
  }
}
