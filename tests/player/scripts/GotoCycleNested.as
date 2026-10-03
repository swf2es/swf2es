// Goto cycles inside other scripts, in a SWF of version 10: B's frame 1
// script sends A to its frame 2, whose script runs in that goto's cycle,
// then sends itself to frame 3, which waits for B's script to return; and
// on frame 2, where the root places an X, L sends itself to frame 3 from an
// ENTER_FRAME listener, whose cycle makes the X with L's own Y.
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
      addFrameScript(1, function():void { trace("A script 2"); });
    }
  }

  public class B extends MovieClip {
    public function B() {
      addFrameScript(0, function():void {
        trace("B script 1");
        MovieClip(parent).a.gotoAndStop(2);
        gotoAndStop(3);
        trace("B after goto", currentFrame);
      }, 2, function():void { trace("B script 3"); });
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
          trace("L after goto", currentFrame, MovieClip(parent).getChildAt(MovieClip(parent).numChildren - 1));
        }
      });
    }
  }

  public class Main extends MovieClip {
    public var a:A;
    public var b:B;
    public var l:L;
    public static var stopped:Boolean = false;

    public function Main() {
      addFrameScript(1, function():void {
        if (!stopped) trace("Main script 2");
        stopped = true;
      });
    }
  }
}
