// A rewind past frames whose first command at a depth does nothing: frame
// 1 moves depth 1 and removes depth 2 while both are empty, frame 2 places
// an A at each, frame 3 removes them and places a B, and frame 4's script
// sends the root back to frame 2. Main traces what holds each depth.
package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.utils.getQualifiedClassName;

  public class A extends MovieClip {
    public function A() { trace("made A"); }
  }

  public class B extends MovieClip {
    public function B() { trace("made B"); }
  }

  public class Main extends MovieClip {
    private var back:Boolean = false;
    private var n:int = 0;

    public function Main() {
      addFrameScript(3, function():void {
        if (!back) {
          back = true;
          gotoAndStop(2);
        }
      });
      addEventListener(Event.EXIT_FRAME, function(_:Event):void {
        if (++n > 5) {
          return;
        }

        var out:Array = [];
        for (var i:int = 0; i < numChildren; i++) {
          var c:DisplayObject = getChildAt(i);
          out.push(getQualifiedClassName(c) + "@" + c.x);
        }

        trace("frame " + currentFrame, out.join(" "));
      });
    }
  }
}
