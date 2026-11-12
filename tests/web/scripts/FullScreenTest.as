package {
  import flash.display.Sprite;
  import flash.display.StageDisplayState;
  import flash.events.FullScreenEvent;
  import flash.events.MouseEvent;
  import flash.external.ExternalInterface;
  import flash.geom.Rectangle;

  // A click toggles full screen over its left half; the page asks for states without one.
  public class FullScreenTest extends Sprite {
    public function FullScreenTest() {
      graphics.beginFill(0xff0000);
      graphics.drawRect(0, 0, 100, 120);
      graphics.beginFill(0x0000ff);
      graphics.drawRect(100, 0, 100, 120);
      stage.addEventListener(FullScreenEvent.FULL_SCREEN, function(e:FullScreenEvent):void {
        say("event " + e.fullScreen + " " + e.interactive + " " + stage.displayState);
      });
      stage.addEventListener(MouseEvent.CLICK, function(e:MouseEvent):void {
        say("click " + ask(stage.displayState == StageDisplayState.NORMAL ? "fullScreen" : "normal"));
      });
      ExternalInterface.addCallback("fsAsk", ask);
      ExternalInterface.addCallback("fsState", function():String {
        return stage.displayState + " " + stage.allowsFullScreen + " " + stage.allowsFullScreenInteractive;
      });
    }

    private function ask(state:String):String {
      try {
        stage.fullScreenSourceRect = new Rectangle(0, 0, 100, 120);
        stage.displayState = state;
      } catch (e:Error) {
        return "refused " + e.errorID;
      }

      return stage.displayState;
    }

    private function say(line:String):void {
      trace(line);
      ExternalInterface.call("fsTrace", line);
    }
  }
}
