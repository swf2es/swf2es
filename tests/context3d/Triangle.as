package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.events.Event;
  import flash.events.ErrorEvent;
  import flash.utils.ByteArray;

  public class Triangle extends Sprite {
    private var current:Context3D;

    public function Triangle() {
      if (stage) {
        start();
      } else {
        addEventListener(Event.ADDED_TO_STAGE, start);
      }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void {
        trace("context-error", e.errorID);
      });
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        var context:Context3D = slot.context3D;
        current = context;
        trace("created", context.profile);
        context.enableErrorChecking = true;
        context.configureBackBuffer(64, 64, 0, false);
        context.clear(0.2, 0.4, 0.6, 1);
        var pixels:BitmapData = new BitmapData(64, 64, true, 0);
        context.drawToBitmapData(pixels);
        trace("clear", pixels.getPixel32(32, 32).toString(16));
        var vertices:VertexBuffer3D = context.createVertexBuffer(3, 4);
        vertices.uploadFromVector(Vector.<Number>([
          -0.75, -0.75, 0.5, 1,
           0.75, -0.75, 0.5, 1,
           0,     0.75, 0.5, 1
        ]), 0, 3);
        var indices:IndexBuffer3D = context.createIndexBuffer(3);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
        var program:Program3D = context.createProgram();
        program.upload(shader(false), shader(true));
        context.setProgram(program);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 1]), 1);
        context.setCulling("none");
        context.drawTriangles(indices);
        context.drawToBitmapData(pixels);
        trace("triangle", pixels.getPixel32(32, 32).toString(16));
        trace("outside", pixels.getPixel32(0, 0).toString(16));
        trace("upper-left", pixels.getPixel32(16, 16).toString(16));
        trace("lower-left", pixels.getPixel32(16, 48).toString(16));
        context.present();
        trace("presented");
        // The presented image must survive subsequent back-buffer writes.
        context.clear(0, 1, 0, 1);
        context.drawToBitmapData(pixels);
        trace("next-clear", pixels.getPixel32(32, 32).toString(16));
        vertices.dispose();
        indices.dispose();
        program.dispose();
        pixels.dispose();
        // Keep the context alive so the host can check the presented image,
        // then exercise context disposal through an AS callback.
        trace("complete");
      });
      trace("request");
      slot.requestContext3D("auto", "baseline");
      trace("request-returned", slot.context3D);
    }

    public function closeContext():void {
      current.dispose(false);
      trace("disposed");
    }

    // AGAL v1: mov op, va0; mov oc, fc0.
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
      bytes.position = 0;
      return bytes;
    }
  }
}
