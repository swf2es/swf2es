// Frame events: a sprite off the display list listening for ENTER_FRAME, the
// root's listeners for ENTER_FRAME in both phases and for EXIT_FRAME, and
// what each sees. Flash says whether the first frame has an ENTER_FRAME,
// in which order the objects hear it, and that a capture listener never does.
package {
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.events.Event;

  public class Main extends MovieClip {
    public function Main() {
      var off:Sprite = new Sprite();
      off.addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        trace("off enterFrame", currentFrame, e.eventPhase, e.target == off, e.currentTarget == off, e.bubbles);
      });
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        trace("root capture");
      }, true);
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        trace("root enterFrame", currentFrame, e.eventPhase, e.target == this);
      });
      addEventListener(Event.FRAME_CONSTRUCTED, function(e:Event):void {
        trace("root frameConstructed", currentFrame);
      });
      addEventListener(Event.EXIT_FRAME, function(e:Event):void {
        trace("root exitFrame", currentFrame);
      });
      addFrameScript(0, frame1, 1, frame2);
      trace("Main");
    }

    private function frame1():void {
      trace("frame 1");
    }

    private function frame2():void {
      trace("frame 2");
    }
  }
}
