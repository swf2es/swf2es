package {
  import flash.display.Sprite;
  import flash.events.TimerEvent;
  import flash.utils.Timer;
  import flash.utils.getTimer;
  public class TimerRestarts extends Sprite {
    public function TimerRestarts() {
      var a:Timer = new Timer(20);
      var b:Timer = new Timer(20);
      var c:Timer = new Timer(20, 3);
      var n:int = 0;
      a.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void {
        n++;
        trace("a", getTimer(), n);
        if (n == 2) { b.stop(); }
        if (n == 4) { b.start(); }
        if (n == 5) { a.reset(); a.start(); }
      });
      b.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { trace("b", getTimer()); });
      c.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { trace("c", getTimer(), c.currentCount); });
      c.addEventListener(TimerEvent.TIMER_COMPLETE, function(e:TimerEvent):void { trace("c done", getTimer()); });
      a.start();
      b.start();
      c.start();
    }
  }
}
