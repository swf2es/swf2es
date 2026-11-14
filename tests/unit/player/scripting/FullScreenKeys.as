package {
  import flash.display.Sprite;
  import flash.events.FullScreenEvent;
  import flash.events.KeyboardEvent;

  public class FullScreenKeys extends Sprite {
    public function FullScreenKeys() {
      stage.addEventListener(FullScreenEvent.FULL_SCREEN, function(e:FullScreenEvent):void {
        trace("event", e.fullScreen);
      });
      // F11 on its way down, F10 on its way up, and F9 where it is refused.
      stage.addEventListener(KeyboardEvent.KEY_DOWN, function(e:KeyboardEvent):void {
        if (e.keyCode == 122) {
          stage.displayState = stage.displayState == "normal" ? "fullScreenInteractive" : "normal";
        } else if (e.keyCode == 120) {
          try {
            stage.displayState = "fullScreen";
          } catch (error:SecurityError) {
            trace("refused", error.errorID);
          }
        } else if (e.keyCode == 119) {
          // To the state it is in, and to the other kind of full screen: nothing the host does.
          stage.displayState = stage.displayState == "normal" ? "normal" : "fullScreen";
        }
      });
      stage.addEventListener(KeyboardEvent.KEY_UP, function(e:KeyboardEvent):void {
        if (e.keyCode == 121) {
          stage.displayState = stage.displayState == "normal" ? "fullScreen" : "normal";
        }
      });
    }
  }
}
