package {
  import flash.display.MovieClip;
  import flash.events.Event;
  public class Bound extends MovieClip {
    public function Bound() {
      stop();
      addFrameScript(1, function():void { throw new Error("from script 2"); },
        2, function():void { throw new Error("from script 3"); });
    }
  }
  public class Main extends MovieClip {
    public var bound:Bound;
    public function Main() {
      addEventListener(Event.ENTER_FRAME, function(_:Event):void {
        if (bound.currentFrame == 1) {
          bound.gotoAndStop(2);
          bound.gotoAndStop(3);
        }
      });
      addEventListener(Event.EXIT_FRAME, function(_:Event):void { trace("exitFrame", bound.currentFrame); });
    }
  }
}
