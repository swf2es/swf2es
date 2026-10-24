package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.ErrorEvent;
  import flash.events.MouseEvent;

  public class StageLayout extends Sprite {
    public var ready:Boolean = false;
    private var events:String = "";
    public var pointerState:String = "";
    public var resizeToShowAll:Boolean = false;

    public function StageLayout() {
      stage.scaleMode = "showAll";
      stage.align = "";
      stage.color = 0x112233;
      graphics.beginFill(0xffffff);
      graphics.drawRect(32, 32, 16, 16);
      graphics.endFill();
      graphics.beginFill(0xffffff, 0.5);
      graphics.drawRect(48, 32, 16, 16);
      graphics.endFill();
      graphics.beginFill(0x00ffff);
      graphics.drawRect(120, 100, 16, 16);
      graphics.endFill();
      graphics.beginFill(0xff00ff);
      graphics.drawRect(-16, -16, 8, 8);
      graphics.endFill();
      stage.addEventListener(MouseEvent.MOUSE_DOWN, function(e:MouseEvent):void {
        pointerState = e.stageX + "," + e.stageY + "," + stage.mouseX + "," + stage.mouseY;
      });
      stage.addEventListener(Event.RESIZE, function(e:Event):void {
        events += stage.stageWidth + "," + stage.stageHeight + "," + e.bubbles + "," + e.cancelable + "," + e.eventPhase + "," + (e.target === stage) + ";";
        if (resizeToShowAll) {
          resizeToShowAll = false;
          stage.scaleMode = "showAll";
        }
      });
      for (var i:int = 0; i < 2; i++) {
        setup(i);
      }
    }

    private function setup(index:int):void {
      var slot:* = stage.stage3Ds[index];
      slot.x = index == 0 ? 8 : 24;
      slot.y = index == 0 ? 8 : 24;
      slot.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void {
        trace("stagelayout error", e.errorID, e.text);
      });
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        slot.context3D.configureBackBuffer(48, 48, 0, false);
        slot.context3D.clear(index == 0 ? 1 : 0, 0, index == 0 ? 0 : 1, 1);
        slot.context3D.present();
        if (stage.stage3Ds[0].context3D && stage.stage3Ds[1].context3D) {
          ready = true;
        }
      });
      slot.requestContext3D("auto", "baseline");
    }

    public function configureLayout(mode:String, alignment:String):String {
      events = "";
      stage.scaleMode = mode;
      stage.align = alignment;
      return layoutState();
    }

    public function layoutState():String {
      return stage.scaleMode + "|" + stage.align + "|" + stage.stageWidth + "|" + stage.stageHeight + "|" + events;
    }

    public function validateSettings():String {
      var result:Array = [];
      for each (var value:* in ["NOSCALE", "noscale", "", null, "wat"]) {
        try {
          stage.scaleMode = value;
          result.push("scale " + value + " accepted");
        } catch (e:Error) {
          result.push("scale " + value + " " + e.name + " " + e.errorID + " " + stage.scaleMode);
        }
      }
      for each (value in ["TL", "tl", "LT", "t", "BOTTOM", "TB", "LR", "LTRB", "hello", "N", "", null]) {
        try {
          stage.align = value;
          result.push("align " + value + " [" + stage.align + "]");
        } catch (e:Error) {
          result.push("align " + value + " " + e.name + " " + e.errorID + " [" + stage.align + "]");
        }
      }
      return result.join(";");
    }
  }
}
