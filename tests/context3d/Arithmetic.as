package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.events.Event;
  import flash.geom.Matrix3D;
  import flash.utils.ByteArray;

  public class Arithmetic extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;

    public function Arithmetic() {
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
        trace("arithmetic complete");
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
      trace("arithmetic", label, pixels.getPixel32(32, 32).toString(16),
        pixels.getPixel32(22, 36).toString(16), pixels.getPixel32(42, 36).toString(16));
      program.dispose();
    }

    private function matrixError(label:String, type:String, first:int, matrix:Matrix3D):void {
      try {
        context.setProgramConstantsFromMatrix(type, first, matrix);
        trace("arithmetic", label, "accepted");
      } catch (error:Error) {
        trace("arithmetic", label, error.name, error.errorID);
      }
    }

    private function run():void {
      var vertex:ByteArray = header(false);
      emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
      var ops:Array = [1, 2, 3, 4, 6, 7, 0x12, 0x13, 0x14, 0x15, 0x16];
      for (var i:int = 0; i < ops.length; i++) {
        var op:uint = ops[i];
        var unary:Boolean = op >= 0x14;
        context.setProgramConstantsFromVector("fragment", 0, unary
          ? Vector.<Number>([-0.25, 1.25, -0.5, 1])
          : Vector.<Number>([0.25, 0.5, 0.75, 1]));
        context.setProgramConstantsFromVector("fragment", 1, Vector.<Number>([0.5, 0.25, 0.125, 1]));
        var fragment:ByteArray = header(true);
        emit(fragment, 0, 0x020f0000, 0xe4000000, 1);
        // Swizzled and masked reads also alias their destination temporary.
        emit(fragment, op, 0x02070000, 0xc6000000, 2, unary ? 0 : 0xe4000001, unary ? 0 : 1);
        emit(fragment, 0, 0x030f0000, 0xe4000000, 2);
        draw("op-" + op, vertex, fragment);
      }
      var matrix:Matrix3D = new Matrix3D(Vector.<Number>([
        0, 0.5, 0, 0, 0.25, 0, 0, 0, 0, 0, 0.5, 0, 0.125, 0.25, 0, 1
      ]));
      var before:String = matrix.rawData.join(",");
      matrixError("null", "vertex", 0, null);
      matrixError("negative-register", "vertex", -1, matrix);
      matrixError("invalid-stage", "invalid", 0, matrix);
      for (var transpose:int = 0; transpose < 2; transpose++) {
        if (transpose == 0) {
          context.setProgramConstantsFromMatrix("fragment", 4, matrix);
        } else {
          context.setProgramConstantsFromMatrix("fragment", 4, matrix, true);
        }
        context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([0.25, 0.5, 0.75, 1]));
        for (op = 0x17; op <= 0x19; op++) {
          fragment = header(true);
          emit(fragment, 0, 0x020f0000, 0xe4000000, 1);
          emit(fragment, op, 0x02070000, 0xe4000000, 2, 0xe4000004, 1);
          emit(fragment, 0, 0x030f0000, 0xe4000000, 2);
          draw("matrix-" + op + "-" + transpose, vertex, fragment);
        }
      }
      trace("arithmetic matrix-unchanged", matrix.rawData.join(",") === before);
      matrix = new Matrix3D(Vector.<Number>([
        0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0.25, 0, 0, 1
      ]));
      vertex = header(false);
      emit(vertex, 0x18, 0x030f0000, 0xe4000000, 0, 0xe4000004, 1);
      fragment = header(true);
      emit(fragment, 0, 0x030f0000, 0xe4000000, 1);
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 1]));
      for (transpose = 0; transpose < 2; transpose++) {
        context.setProgramConstantsFromMatrix("vertex", 4, matrix, transpose != 0);
        draw("position-" + transpose, vertex, fragment);
      }
    }
  }
}
