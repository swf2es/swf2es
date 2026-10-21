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

  public class ScalarMath extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;
    private var checks:int = 0;

    public function ScalarMath() {
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
        trace("scalarmath checks", checks);
        trace("scalarmath complete");
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

    private function calculate(op:uint, value:Number):Number {
      switch (op) {
        case 5: return 1 / value;
        case 0x0c: return Math.log(value) / Math.LN2;
        case 0x0d: return Math.pow(2, value);
        case 0x0f: return Math.sin(value);
        case 0x10: return Math.cos(value);
      }

      throw new Error("Unknown operation");
    }

    private function draw(label:String, vertex:ByteArray, fragment:ByteArray, expected:Array):void {
      var program:Program3D = context.createProgram();
      program.upload(vertex, fragment);
      context.setProgram(program);
      context.clear(0, 0, 1, 1);
      context.drawTriangles(indices);
      context.drawToBitmapData(pixels);

      var locations:Array = [[32, 32], [22, 36], [42, 36]];

      for (var p:int = 0; p < locations.length; p++) {
        var actual:uint = pixels.getPixel32(locations[p][0], locations[p][1]);
        if ((actual >>> 24) != 255) { throw new Error(label + " alpha"); }

        for (var channel:int = 0; channel < 3; channel++) {
          var wanted:int = Math.round(Math.max(0, Math.min(1, expected[channel])) * 255);
          var found:int = (actual >>> ((2 - channel) * 8)) & 255;
          // Allow one byte for GPU approximation and color quantization.
          if (Math.abs(wanted - found) > 1) {
            throw new Error(label + " channel " + channel + ": " + found + " != " + wanted);
          }
        }
        checks++;
      }

      program.dispose();
    }

    private function run():void {
      var ops:Array = [5, 0x0c, 0x0d, 0x0f, 0x10];
      var inputs:Array = [
        [[0.25, -0.5, 2, -4], [-1, 0.75, -2, 4]],
        [[0.25, 0.5, 2, 4], [0.125, 0.75, 1, 3]],
        [[-2, -1, 0, 1], [-0.75, 0.25, 0.5, 2]],
        [[-3, -1, 0.5, 2], [-0.25, 0, 0.75, 3]],
        [[-3, -1, 0.5, 2], [-0.25, 0, 0.75, 3]]
      ];
      var masks:Array = [15, 5, 8, 1, 2, 4, 8];
      var swizzles:Array = [0xe4, 0x1b];
      for (var stageIndex:int = 0; stageIndex < 2; stageIndex++) {
        var stageName:String = stageIndex == 0 ? "vertex" : "fragment";
        context.setProgramConstantsFromVector(stageName, 1, Vector.<Number>([0.125, 0.125, 0.125, 0.125]));
        context.setProgramConstantsFromVector(stageName, 2, Vector.<Number>([0.5, 0.5, 0.5, 1]));
        for (var i:int = 0; i < ops.length; i++) {
          for (var input:int = 0; input < 2; input++) {
            var values:Array = inputs[i][input];
            context.setProgramConstantsFromVector(stageName, 0, Vector.<Number>(values));
            for (var m:int = 0; m < masks.length; m++) {
              for (var s:int = 0; s < (m < 3 ? swizzles.length : 1); s++) {
                var swizzle:uint = m < 3 ? swizzles[s] : (m - 3) * 0x55;
                for (var alias:int = 0; alias < 2; alias++) {
                  // The tested AIR backend differs when an overlapping read shuffles written lanes.
                  var unsupported:Boolean = false;
                  if (alias == 1 && ops[i] != 0x0f && ops[i] != 0x10) {
                    for (var written:int = 0; written < 4; written++) {
                      if ((masks[m] & (1 << written)) != 0 && ((swizzle >>> (written * 2)) & 3) != written) {
                        unsupported = true;
                      }
                    }
                  }

                  if (unsupported) { continue; }

                  // A second pass reads w as RGB, independently of alpha conversion.
                  for (var readW:int = 0; readW < 2; readW++) {
                    var vertex:ByteArray = header(false);
                    emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
                    var fragment:ByteArray = header(true);
                    var math:ByteArray = stageIndex == 0 ? vertex : fragment;
                    emit(math, 0, 0x020f0000, 0xe4000000, 1);
                    emit(math, 0, 0x020f0001, 0xe4000000, 1);
                    var dest:int = alias == 1 ? 0 : 1;
                    emit(math, ops[i], 0x02000000 | (masks[m] << 16) | dest, swizzle << 24, 2);
                    // Keep negative results visible and test the full range before clamping.
                    emit(math, 3, 0x020f0002, (readW == 1 ? 0xff000000 : 0xe4000000) | dest, 2, 0xe4000001, 1);
                    emit(math, 1, 0x02070002, 0xe4000002, 2, 0xe4000002, 1);
                    emit(math, 0, 0x02080002, 0xff000002, 1);
                    emit(math, 0, stageIndex == 0 ? 0x040f0000 : 0x030f0000, 0xe4000002, 2);
                    if (stageIndex == 0) { emit(fragment, 0, 0x030f0000, 0xe4000000, 4); }
                    var expected:Array = [];
                    for (var channel:int = 0; channel < 3; channel++) {
                      var lane:int = readW == 1 ? 3 : channel;
                      var value:Number = (masks[m] & (1 << lane)) != 0
                        ? calculate(ops[i], values[(swizzle >>> (lane * 2)) & 3]) : values[lane];
                      expected.push(value * 0.125 + 0.5);
                    }
                    draw(stageName + "-" + ops[i] + "-" + input + "-" + masks[m] + "-" + s + "-" + alias + "-" + readW,
                      vertex, fragment, expected);
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
