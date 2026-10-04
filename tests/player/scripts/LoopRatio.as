// A clip L of three frames that loops on its own, no script sending it:
// its first frame places a C and a D, and its later frames move the C to
// ratios 1 and 2, as a tween writes them, and leave the D. Each frame
// script of L, ENTER_FRAME, FRAME_CONSTRUCTED and EXIT_FRAME trace, so
// that where a C is made anew at the loop shows against them.
package {
  import flash.display.MovieClip;
  import flash.events.Event;

  public class C extends MovieClip {
    public static var made:int = 0;
    public var id:int;

    public function C() {
      id = ++made;
      trace("made C " + id);
    }
  }

  public class D extends MovieClip {
    public function D() { trace("made D"); }
  }

  public class L extends MovieClip {
    public function L() {
      addFrameScript(0, function():void { trace("L script 1, C " + held()); });
      addFrameScript(1, function():void { trace("L script 2, C " + held()); });
      addFrameScript(2, function():void { trace("L script 3, C " + held()); });
    }

    public function held():String {
      var c:C = numChildren > 0 ? getChildAt(0) as C : null;
      return c ? c.id + "@" + c.x : "none";
    }
  }

  public class Main extends MovieClip {
    private var n:int = 0;

    public function Main() {
      addEventListener(Event.ENTER_FRAME, function(_:Event):void {
        if (n < 8) {
          trace("enter " + (n + 1) + ", C " + clip());
        }
      });
      addEventListener(Event.FRAME_CONSTRUCTED, function(_:Event):void {
        if (n < 8) {
          trace("constructed, C " + clip());
        }
      });
      addEventListener(Event.EXIT_FRAME, function(_:Event):void {
        if (n++ < 8) {
          trace("exit, C " + clip());
        }
      });
    }

    private function clip():String {
      var l:L = numChildren > 0 ? getChildAt(0) as L : null;
      return l ? l.held() : "no L";
    }
  }
}
