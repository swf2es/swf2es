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

  // AGAL pow with negative and zero bases, in each stage: what AIR draws.
  // AIR gives |a|^b, as Direct3D's pow does. Its 0^0 is NaN, which drivers
  // write to a color target differently, so no lane asks for it.
  public class PowerSigns extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;

    public function PowerSigns() {
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
        trace("powersigns complete");
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

    private function run():void {
      var cases:Array = [
        [[-0.5, -0.75, -0.25, 0], [1, 2, 0.5, 0]],
        [[-0.25, -0.5, -0.0625, 0], [3, 1, 0.25, 0]],
        [[0.5, -0.5, 0, 0], [-1, -1, 2, 0]],
        [[0, 0, -1, 0], [0.5, 1, 3, 0]],
        [[-2, -0.5, 0.25, 0], [-2, 0, 0.5, 0]]
      ];
      for (var stageIndex:int = 0; stageIndex < 2; stageIndex++) {
        var stageName:String = stageIndex == 0 ? "vertex" : "fragment";
        for (var i:int = 0; i < cases.length; i++) {
          context.setProgramConstantsFromVector(stageName, 0, Vector.<Number>(cases[i][0]));
          context.setProgramConstantsFromVector(stageName, 1, Vector.<Number>(cases[i][1]));
          context.setProgramConstantsFromVector(stageName, 2, Vector.<Number>([0, 0, 0, 1]));
          var vertex:ByteArray = header(false);
          var fragment:ByteArray = header(true);
          emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
          var math:ByteArray = stageIndex == 0 ? vertex : fragment;
          // mov t1, c1; pow t0.xyz, c0, t1; mov t0.w, c2.w
          emit(math, 0, 0x020f0001, 0xe4000001, 1);
          emit(math, 0x0b, 0x02070000, 0xe4000000, 1, 0xe4000001, 2);
          emit(math, 0, 0x02080000, 0xff000002, 1);
          if (stageIndex == 0) {
            emit(vertex, 0, 0x040f0000, 0xe4000000, 2);
            emit(fragment, 0, 0x030f0000, 0xe4000000, 4);
          } else {
            emit(fragment, 0, 0x030f0000, 0xe4000000, 2);
          }
          var program:Program3D = context.createProgram();
          program.upload(vertex, fragment);
          context.setProgram(program);
          context.clear(0, 0, 1, 1);
          context.drawTriangles(indices);
          context.drawToBitmapData(pixels);
          trace("powersigns", stageName, i, pixels.getPixel32(32, 32).toString(16));
          program.dispose();
        }
      }
    }
  }
}
