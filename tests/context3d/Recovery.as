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

  public class Recovery extends Sprite {
    private var slot:Stage3D;
    private var previous:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var program:Program3D;
    private var texture:Texture;
    private var bitmap:BitmapData = new BitmapData(2, 2, true, 0xffffffff);
    private var generation:int = 0;

    public function Recovery() {
      if (stage) {
        start();
      } else {
        addEventListener(Event.ADDED_TO_STAGE, start);
      }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      slot = stage.stage3Ds[0];
      slot.x = 7;
      slot.y = 11;
      slot.visible = false;
      slot.addEventListener(Event.CONTEXT3D_CREATE, created);
      slot.requestContext3D("auto", "baseline");
    }

    private function probe(label:String, action:Function):void {
      try {
        trace("recovery", label, action());
      } catch (error:Error) {
        trace("recovery", label, error.name, error.errorID);
      }
    }

    public function inspectLost():void {
      trace("recovery", "empty", slot.context3D == null);
      trace("recovery", "disposed", previous.driverInfo, previous.backBufferWidth, previous.profile);
      inspectResources();
    }

    private function inspectResources():void {
      probe("context", function():void { previous.clear(); });
      probe("buffer", function():void { vertices.uploadFromVector(new Vector.<Number>(12), 0, 3); });
      probe("indices", function():void { indices.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3); });
      probe("program", function():void { program.upload(new ByteArray(), new ByteArray()); });
      probe("texture", function():void { texture.uploadFromBitmapData(bitmap); });
    }

    private function created(event:Event):void {
      generation++;
      var current:Context3D = slot.context3D;
      trace("recovery", "created", generation, current !== previous);
      trace("recovery", "initial", current.backBufferWidth, current.backBufferHeight, current.enableErrorChecking);
      if (previous) {
        inspectResources();
        previous.dispose(false);
        vertices.dispose();
        indices.dispose();
        program.dispose();
        texture.dispose();
        trace("recovery", "survived", slot.context3D === current);
      }
      current.configureBackBuffer(32, 32, 0, true);
      current.enableErrorChecking = true;
      current.clear(0, 0, 0, 1);
      previous = current;
      vertices = current.createVertexBuffer(3, 4);
      vertices.uploadFromVector(Vector.<Number>([
        -0.75, -0.75, 0.5, 1,
         0.75, -0.75, 0.5, 1,
         0,     0.75, 0.5, 1
      ]), 0, 3);
      indices = current.createIndexBuffer(3);
      indices.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
      program = current.createProgram();
      program.upload(shader(false), shader(true));
      current.setProgram(program);
      current.setVertexBufferAt(0, vertices, 0, "float4");
      current.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([
        generation == 1 ? 1 : 0, generation == 2 ? 1 : 0, generation > 2 ? 1 : 0, 1
      ]), 1);
      current.drawTriangles(indices);
      current.present();
      // The next context must start with fresh depth and culling defaults.
      current.setDepthTest(false, "never");
      current.setCulling("frontAndBack");
      texture = current.createTexture(2, 2, "bgra", false);
      texture.uploadFromBitmapData(bitmap);
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
      bytes.position = 0;
      return bytes;
    }
  }
}
