package {
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.events.Event;
  import flash.events.ErrorEvent;

  public class Composition extends Sprite {
    public var ready:Boolean = false;
    private var lower:Stage3D;
    private var upper:Stage3D;

    public function Composition() {
      if (stage) {
        start();
      } else {
        addEventListener(Event.ADDED_TO_STAGE, start);
      }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      stage.scaleMode = "noScale";
      stage.align = "TL";
      stage.color = 0x112233;
      graphics.beginFill(0xffffff);
      graphics.drawRect(32, 32, 16, 16);
      graphics.endFill();
      graphics.beginFill(0xffffff, 0.5);
      graphics.drawRect(48, 32, 16, 16);
      graphics.endFill();
      lower = stage.stage3Ds[0];
      upper = stage.stage3Ds[1];
      lower.x = 8;
      lower.y = 8;
      upper.x = 24;
      upper.y = 24;
      lower.addEventListener(ErrorEvent.ERROR, contextError);
      upper.addEventListener(ErrorEvent.ERROR, contextError);
      // Create the higher slot first: creation order must not choose depth.
      upper.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        trace("layer-created", 1);
        upper.context3D.configureBackBuffer(48, 48, 0, false);
        upper.context3D.clear(0, 0, 1, 1);
        upper.context3D.present();
        lower.requestContext3D("auto", "baseline");
      });
      lower.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        trace("layer-created", 0);
        lower.context3D.configureBackBuffer(48, 48, 0, false);
        // Stage3D surfaces are opaque even when their clear alpha is zero.
        lower.context3D.clear(1, 0, 0, 0);
        lower.context3D.present();
        ready = true;
      });
      upper.requestContext3D("auto", "baseline");
    }

    private function contextError(event:ErrorEvent):void {
      trace("composition-error", event.errorID, event.text);
    }

    public function advance(step:int):void {
      switch (step) {
        case 0:
          break;
        case 1:
          lower.visible = false;
          break;
        case 2:
          lower.x = 40;
          lower.y = 0;
          lower.visible = true;
          break;
        case 3:
          lower.context3D.clear(0, 1, 0, 1);
          break;
        case 4:
          lower.context3D.present();
          break;
        case 5:
          lower.context3D.configureBackBuffer(32, 32, 0, false);
          lower.context3D.clear(1, 0, 0, 1);
          lower.context3D.present();
          break;
        case 6:
          lower.x = -8;
          lower.y = -8;
          break;
        case 7:
          lower.context3D.dispose(false);
          break;
        case 8:
          upper.context3D.dispose(false);
          break;
        default:
          throw new Error("Unknown composition step");
      }
    }
  }
}
