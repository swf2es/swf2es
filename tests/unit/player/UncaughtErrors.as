package {
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.events.Event;
  public class Bound extends MovieClip {
    public function Bound() {
      stop();
      addFrameScript(1, function():void { trace("Bound script 2 throws"); throw new Error("from script 2"); },
        2, function():void { trace("Bound script 3 throws"); throw new Error("from script 3"); });
    }
  }
  public class Bad extends MovieClip {
    public function Bad() { trace("making Bad"); throw new Error("from Bad"); }
  }
  public class Good extends MovieClip {
    public function Good() { trace("made Good"); }
  }
  public class Main extends MovieClip {
    public var bound:Bound;
    private var n:int = 0;
    private var other:Sprite = new Sprite();
    public function Main() {
      stop();
      addEventListener(Event.FRAME_CONSTRUCTED, function(_:Event):void {
        if (n == 1) { trace("frameConstructed 1 throws"); throw new Error("from frameConstructed"); }
      });
      addEventListener(Event.FRAME_CONSTRUCTED, function(_:Event):void {
        if (n == 1) trace("frameConstructed 2");
      });
      addEventListener(Event.EXIT_FRAME, function(_:Event):void {
        if (n == 1) { trace("exitFrame 1 throws"); throw new Error("from exitFrame"); }
      });
      addEventListener(Event.EXIT_FRAME, function(_:Event):void {
        if (n == 1) trace("exitFrame 2");
      });
      other.addEventListener(Event.EXIT_FRAME, function(_:Event):void {
        if (n == 1) trace("exitFrame other");
      });
      addEventListener(Event.ENTER_FRAME, enter);
    }
    private function enter(e:Event):void {
      n++;
      if (n == 2) {
        trace("goto 2 and 3");
        bound.gotoAndStop(2);
        bound.gotoAndStop(3);
        trace("after both gotos", bound.currentFrame);
      } else if (n == 3) {
        trace("next frame");
        gotoAndStop(2);
        trace("after root goto", numChildren);
      }
    }
  }
}
