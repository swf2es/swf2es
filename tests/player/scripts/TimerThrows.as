// A timer whose first firing throws must keep running and fire again.
// Driven by a node test; Flash does not run it.
package {
  import flash.display.MovieClip;
  import flash.events.TimerEvent;
  import flash.utils.Timer;
  import flash.utils.getTimer;

  public class Main extends MovieClip {
    public function Main() {
      var timer:Timer = new Timer(100);
      var count:int = 0;
      timer.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void {
        count++;
        trace("firing", count, getTimer(), timer.running);
        if (count == 1) {
          throw new Error("the first firing fails");
        }
      });
      timer.start();
    }
  }
}
