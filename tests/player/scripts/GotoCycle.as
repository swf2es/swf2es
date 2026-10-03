// What a goto runs in a SWF of version 10: Main traces its frame events,
// A traces its frame scripts, B jumps from its frame 2 script to frame 4,
// which places an X, and L jumps from an ENTER_FRAME listener on its frame
// 2 to frame 3, which places a Y; X and Y trace their making. Main stops
// after its third frame: the goto cycles' EXIT_FRAMEs count as frames to
// the oracle's harness, which ends its run early by as many.
package {
  import flash.display.MovieClip;
  import flash.events.Event;

  public class X extends MovieClip {
    public function X() { trace("made X"); }
  }

  public class Y extends MovieClip {
    public function Y() { trace("made Y"); }
  }

  public class A extends MovieClip {
    public function A() {
      addFrameScript(0, function():void { say("A script 1"); },
        1, function():void { say("A script 2"); },
        2, function():void { say("A script 3"); },
        3, function():void { say("A script 4"); });
    }

    private static function say(what:String):void {
      if (!Main.stopped) trace(what);
    }
  }

  public class B extends MovieClip {
    public function B() {
      addFrameScript(1, function():void {
        trace("B script 2, goto 4");
        gotoAndStop(4);
        trace("B after goto", currentFrame, numChildren);
      }, 3, function():void { trace("B script 4"); });
    }
  }

  public class L extends MovieClip {
    private var done:Boolean = false;

    public function L() {
      addFrameScript(2, function():void { trace("L script 3"); });
      addEventListener(Event.ENTER_FRAME, function(_:Event):void {
        if (!done && currentFrame == 2) {
          done = true;
          trace("L enterFrame, goto 3");
          gotoAndStop(3);
          trace("L after goto", currentFrame, numChildren);
        }
      });
    }
  }

  public class Main extends MovieClip {
    public static var stopped:Boolean = false;
    private var n:int = 0;

    public function Main() {
      addEventListener(Event.ENTER_FRAME, function(_:Event):void {
        if (++n <= 3) trace("Main enterFrame " + n);
      });
      addEventListener(Event.FRAME_CONSTRUCTED, function(_:Event):void {
        if (n <= 3) trace("Main frameConstructed " + n);
      });
      addEventListener(Event.EXIT_FRAME, function(_:Event):void {
        if (n <= 3) trace("Main exitFrame " + n);
        stopped = n >= 3;
      });
    }
  }
}
