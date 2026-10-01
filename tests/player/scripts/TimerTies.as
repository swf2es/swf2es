// Two timers due at once keep the order they were started in, through the
// stopping of three others around them, which has the player's heap of
// timers rebuilt. Driven by a node test; Flash does not run it.
package {
  import flash.display.MovieClip;
  import flash.events.TimerEvent;
  import flash.utils.Timer;
  import flash.utils.getTimer;

  public class Main extends MovieClip {
    public function Main() {
      var names:Array = ["A", "B", "C", "D", "E"];
      var delays:Array = [100, 200, 200, 50, 300];
      var timers:Array = [];
      for (var i:int = 0; i < names.length; i++) {
        var timer:Timer = new Timer(delays[i]);
        timer.addEventListener(TimerEvent.TIMER, report(names[i]));
        timer.start();
        timers.push(timer);
      }

      timers[0].stop();
      timers[3].stop();
      timers[4].stop();
    }

    private function report(name:String):Function {
      return function(e:TimerEvent):void {
        trace(name, getTimer());
      };
    }
  }
}
