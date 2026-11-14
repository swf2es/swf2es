package {
  import flash.display.MovieClip;
  import flash.events.Event;
  public class Bound extends MovieClip {
    public var runs:int = 0;
    public function Bound() {
      addFrameScript(0, function():void { runs++; }, 1, function():void { runs++; });
    }
  }
  public class Main extends MovieClip {
    public var bound:Bound;
    public var kept:Bound;
    public var listening:Bound;
    public function Main() {
      kept = bound;
      removeChild(bound);
      listening = new Bound();
      listening.addEventListener(Event.ENTER_FRAME, function(e:Event):void {});
    }
  }
}
