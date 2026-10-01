// Two timers of different delays, each tracing the time it fires at: they
// must interleave as their times do, and getTimer must tell each its own
// time. Driven by a node test; Flash does not run it.
package {
  import flash.display.MovieClip;
  import flash.events.TimerEvent;
  import flash.utils.Timer;
  import flash.utils.getTimer;

  public class Main extends MovieClip {
    public function Main() {
      var a:Timer = new Timer(100);
      a.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { trace("A", getTimer()); });
      var b:Timer = new Timer(150);
      b.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { trace("B", getTimer()); });
      a.start();
      b.start();
    }
  }
}
