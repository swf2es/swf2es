// A walk placed by the time between frames, which takes itself to have
// arrived when two ENTER_FRAMEs move it less than a pixel, as a large
// real-world SWF's avatars do: frames run back to back, with no time
// between them, stop it short. Flash never runs them so, after a long
// frame either. Driven by a node test with a host that lags; Flash does
// not run it.
package {
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.utils.getTimer;

  public class Main extends MovieClip {
    // 300 px at 176 px/s.
    private static const DISTANCE:Number = 300;
    private static const DURATION:Number = 1705;

    private var start:int = -1;
    private var last:Number = 0;

    public function Main() {
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function step(e:Event):void {
      var now:int = getTimer();
      if (start < 0) {
        start = now;
        return;
      }

      var r:Number = Math.min(1, (now - start) / DURATION);
      var x:Number = DISTANCE * r;
      if (Math.round(x) == Math.round(last) && now > start + 50) {
        removeEventListener(Event.ENTER_FRAME, step);
        trace(r < 1 ? "stopped short at " + Math.round(x) : "arrived");
      }

      last = x;
    }
  }
}
