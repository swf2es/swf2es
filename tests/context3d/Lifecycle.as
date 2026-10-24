package {
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class Lifecycle extends Sprite {
    public var complete:Boolean = false;
    private var slot:Stage3D;
    private var previous:Context3D;
    private var vertices:VertexBuffer3D;
    private var program:Program3D;
    private var generation:int = 0;

    public function Lifecycle() {
      if (stage) {
        start();
      } else {
        addEventListener(Event.ADDED_TO_STAGE, start);
      }
    }

    private function probe(label:String, action:Function):void {
      try {
        trace("life", label, action());
      } catch (error:Error) {
        trace("life", label, error.name, error.errorID);
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
      trace("life", "requested", slot.context3D == null);
    }

    private function created(event:Event):void {
      generation++;
      var current:Context3D = slot.context3D;
      trace("life", "created", generation, current !== previous, slot.x, slot.y, slot.visible);
      trace("life", "initial", current.backBufferWidth, current.backBufferHeight, current.enableErrorChecking);
      current.enableErrorChecking = true;
      if (generation == 1) {
        probe("unconfigured", function():void { current.clear(); });
        probe("width", function():void { current.configureBackBuffer(31, 32, 0, false); });
        probe("height", function():void { current.configureBackBuffer(32, 31, 0, false); });
        current.configureBackBuffer(32, 32, 0, false);
        current.clear(1, 0, 0, 1);
        current.present();
        vertices = current.createVertexBuffer(3, 4);
        program = current.createProgram();
        previous = current;
        current.dispose();
        trace("life", "disposed-slot", slot.context3D == null, slot.context3D === previous);
        probe("disposed-driver", function():String { return previous.driverInfo; });
        probe("disposed-width", function():int { return previous.backBufferWidth; });
        probe("disposed-height", function():int { return previous.backBufferHeight; });
        probe("disposed-profile", function():String { return previous.profile; });
        probe("disposed-checking", function():Boolean { return previous.enableErrorChecking; });
        probe("disposed-clear", function():void { previous.clear(); });
        probe("disposed-configure", function():void { previous.configureBackBuffer(32, 32, 0, false); });
        probe("disposed-upload", function():void { vertices.uploadFromVector(new Vector.<Number>(12), 0, 3); });
        probe("disposed-program", function():void { program.upload(new ByteArray(), new ByteArray()); });
        probe("retired-buffer-dispose", function():void { vertices.dispose(); });
        probe("retired-program-dispose", function():void { program.dispose(); });
        trace("life", "dispose-returned", generation);
      } else if (generation == 2) {
        probe("old-dispose", function():void { previous.dispose(false); });
        trace("life", "current-survived", slot.context3D === current);
        current.configureBackBuffer(32, 32, 0, false);
        current.clear(0, 1, 0, 1);
        current.present();
        current.dispose(false);
        trace("life", "no-recreate", slot.context3D == null, slot.context3D === current);
        previous = current;
        slot.requestContext3D("auto", "baseline");
        trace("life", "requested-again", generation);
      } else {
        current.configureBackBuffer(32, 32, 0, false);
        current.clear(0, 0, 1, 1);
        current.present();
        current.dispose(false);
        trace("life", "complete", generation);
        complete = true;
      }
    }
  }
}
