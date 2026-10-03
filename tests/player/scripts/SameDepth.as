// Places without the move flag at a depth already taken: A then B in frame
// 1, C in frame 2, D in frame 3 after a remove, and the loop back to frame
// 1, beside E placed at depth 2 on frame 2 and never removed. Each traces
// its making, and Main what is placed at each EXIT_FRAME.
package {
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.utils.getQualifiedClassName;

  public class A extends MovieClip {
    public function A() { trace("made A"); }
  }

  public class B extends MovieClip {
    public function B() { trace("made B"); }
  }

  public class C extends MovieClip {
    public function C() { trace("made C"); }
  }

  public class D extends MovieClip {
    public function D() { trace("made D"); }
  }

  public class E extends MovieClip {
    public function E() { trace("made E"); }
  }

  public class Main extends MovieClip {
    private var n:int = 0;

    public function Main() {
      addEventListener(Event.EXIT_FRAME, function(_:Event):void {
        if (++n > 7) {
          return;
        }

        var names:Array = [];
        for (var i:int = 0; i < numChildren; i++) {
          names.push(getQualifiedClassName(getChildAt(i)));
        }

        trace("frame " + n, numChildren, names.join(" "));
      });
    }
  }
}
