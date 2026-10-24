package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.Texture;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class FrameValidation extends Sprite {
    public var complete:Boolean = false;
    private const backDepth:Boolean = true;
    private var context:Context3D;
    private var pixels:BitmapData;
    private var indices:IndexBuffer3D;

    public function FrameValidation() {
      if (stage) { start(); }
      else { addEventListener(Event.ADDED_TO_STAGE, start); }
    }

    private function probe(label:String, action:Function):void {
      try {
        pixels.fillRect(pixels.rect, 0xff123456);
        action();
        trace("framevalidation", label, "ok");
      } catch (error:Error) {
        if (pixels.getPixel32(0, 0) != 0xff123456) {
          throw new Error("Failed operation changed destination: " + label);
        }
        trace("framevalidation", label, error.name, error.errorID);
      }
    }

    private function read():void { context.drawToBitmapData(pixels); }
    private function draw():void { context.drawTriangles(indices); }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        context = slot.context3D;
        context.enableErrorChecking = true;
        pixels = new BitmapData(64, 64, true, 0);
        probe("unconfigured-read", read);
        context.configureBackBuffer(64, 64, 0, backDepth);
        probe("configured-read", read);
        var vertices:VertexBuffer3D = context.createVertexBuffer(3, 4);
        vertices.uploadFromVector(Vector.<Number>([-0.8, -0.8, 0, 1, 0.8, -0.8, 0, 1, 0, 0.8, 0, 1]), 0, 3);
        indices = context.createIndexBuffer(3);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        var program:Program3D = context.createProgram();
        program.upload(shader(false), shader(true));
        context.setProgram(program);
        context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 1]));
        probe("configured-draw", draw);
        run();
        context.dispose(false);
        probe("disposed-read", read);
        vertices.dispose(); indices.dispose(); program.dispose(); pixels.dispose();
        complete = true;
        trace("framevalidation complete");
      });
      slot.requestContext3D("auto", "baseline");
    }

    private function shader(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0); bytes.writeUnsignedInt(1);
      bytes.writeByte(0xa1); bytes.writeByte(fragment ? 1 : 0);
      bytes.writeUnsignedInt(0); bytes.writeUnsignedInt(0x030f0000);
      bytes.writeUnsignedInt(0xe4000000); bytes.writeUnsignedInt(fragment ? 1 : 0);
      bytes.writeUnsignedInt(0); bytes.writeUnsignedInt(0);
      return bytes;
    }

    private function run():void {
      for (var mode:int = 0; mode < 4; mode++) {
        var checking:int = mode & 1;
        var depth:Boolean = mode >= 2;
        context.configureBackBuffer(64, 64, 0, backDepth);
        context.enableErrorChecking = Boolean(checking);
        var label:String = "target-depth-" + depth + "-checking-" + checking + "-";
        var texture:Texture = context.createTexture(8, 8, "bgra", true);
        context.clear(0, 0, 1, 1);
        probe(label + "cleared-read", read);
        context.present();
        probe(label + "presented-read", read);
        probe(label + "presented-draw", draw);
        probe(label + "present-again", function():void { context.present(); });
        context.configureBackBuffer(64, 64, 0, backDepth);
        probe(label + "reconfigured-read", read);
        context.configureBackBuffer(96, 96, 0, backDepth);
        context.configureBackBuffer(64, 64, 0, backDepth);
        probe(label + "resized-read", read);
        context.clear(0, 0, 1, 1);
        context.configureBackBuffer(96, 96, 0, backDepth);
        context.configureBackBuffer(64, 64, 0, backDepth);
        probe(label + "cleared-resized-read", read);
        var masks:Array = [0, 1, 2, 3, 4, 5, 6, 7];
        for (var i:int = 0; i < masks.length; i++) {
          context.clear(0, 0, 1, 1);
          context.present();
          context.clear(0, 1, 0, 1, 1, 0, masks[i]);
          probe(label + "mask-" + masks[i] + "-read", read);
          probe(label + "mask-" + masks[i] + "-draw", draw);
        }
        context.clear(0, 0, 1, 1);
        context.present();
        context.clear(0, 1, 0, 1, 1, 0, 1);
        context.clear(0, 1, 0, 1, 1, 0, 2);
        context.clear(0, 1, 0, 1, 1, 0, 4);
        probe(label + "split-clears-read", read);
        context.present();
        context.setRenderToTexture(texture, depth);
        probe(label + "target-before-clear-read", read);
        probe(label + "target-before-clear-draw", draw);
        probe(label + "target-after-draw-read", read);
        context.clear(0, 1, 0, 1);
        probe(label + "target-cleared-read", read);
        probe(label + "target-present-no-back-clear", function():void { context.present(); });
        probe(label + "immediate-after-target-present-read", read);
        context.setRenderToTexture(texture, depth);
        probe(label + "target-after-present-read", read);
        context.setRenderToBackBuffer();
        probe(label + "target-return-read", read);
        probe(label + "target-return-draw", draw);
        context.clear(0, 0, 1, 1);
        context.setRenderToTexture(texture, depth);
        probe(label + "back-cleared-target-read", read);
        context.present();
        probe(label + "target-presented-read", read);
        context.setRenderToBackBuffer();
        context.clear(0, 0, 1, 1);
        texture.dispose();
        for (i = 0; i < masks.length; i++) {
          texture = context.createTexture(8, 8, "bgra", true);
          context.setRenderToTexture(texture, depth);
          probe(label + "fresh-target-" + masks[i] + "-read", read);
          context.clear(0, 1, 0, 1, 1, 0, masks[i]);
          probe(label + "target-mask-" + masks[i] + "-read", read);
          probe(label + "target-mask-" + masks[i] + "-draw", draw);
          context.setRenderToBackBuffer();
          texture.dispose();
        }
        texture = context.createTexture(8, 8, "bgra", true);
        var small:BitmapData = new BitmapData(4, 4, true, 0xff0000ff);
        texture.uploadFromBitmapData(small, 1);
        context.setRenderToTexture(texture, depth);
        probe(label + "mip-uploaded-target-read", read);
        context.setRenderToBackBuffer();
        small.dispose();
        var upload:BitmapData = new BitmapData(8, 8, true, 0xff0000ff);
        texture.uploadFromBitmapData(upload);
        context.setRenderToTexture(texture, depth);
        probe(label + "uploaded-target-read", read);
        probe(label + "uploaded-target-draw", draw);
        context.clear(0, 0, 1, 1);
        context.setRenderToTexture(texture, !depth);
        probe(label + "changed-target-depth-read", read);
        context.setRenderToBackBuffer();
        texture.dispose(); upload.dispose();
      }
    }
  }
}
