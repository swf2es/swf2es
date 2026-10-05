package {
  import flash.display.MovieClip;
  import flash.events.Event;

  public class State extends MovieClip {
    private static var jumped:Boolean = false;

    public function State() {
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      if (!jumped) {
        jumped = true;
        gotoAndStop(2);
      }
    }
  }

  public class Menu extends MovieClip {
    public function Menu() {
      trace("menu constructor", numChildren);
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      trace("menu frame 1", stage != null, numChildren);
      stop();
    }
  }

  public class Main extends MovieClip {
    public function Main() {
      addEventListener(Event.ENTER_FRAME, onFrame);
    }

    private function onFrame(event:Event):void {
      removeEventListener(Event.ENTER_FRAME, onFrame);
      addChild(new Menu());
      trace("menu attached");
    }
  }
}
