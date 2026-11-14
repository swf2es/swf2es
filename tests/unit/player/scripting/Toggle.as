package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.FullScreenEvent;
  import flash.geom.Rectangle;

  public class Toggle extends Sprite {
    private var frame:int = 0;

    public function Toggle() {
      trace("allows", stage.allowsFullScreen, stage.allowsFullScreenInteractive);
      stage.addEventListener(FullScreenEvent.FULL_SCREEN, function(e:FullScreenEvent):void {
        trace("event", e.fullScreen, e.interactive, stage.displayState);
      });
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        frame++;
        if (frame == 1 || frame == 3) {
          try {
            stage.displayState = frame == 1 ? "fullScreen" : "fullScreenInteractive";
          } catch (e:Error) {
            trace("thrown", e.name, e.errorID);
          }
        }
        trace("frame", frame, stage.displayState);
      });
    }
  }
}
