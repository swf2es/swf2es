// A rewind past places of another clip, as authoring tools write them, each
// with a ratio of its own: frame 1 places an A at depths 1 to 3, depth 2's
// with ratio 5; frame 2 removes depths 1 and 2 and places a B, depth 1's
// with ratio 1 and depth 2's with ratio 5, and moves depth 3 to ratio 9;
// frame 3's script sends the root back to frame 1. Main traces what holds
// each depth.
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
      addFrameScript(2, function():void {
        if (!back) {
          back = true;
          gotoAndStop(1);
        }
      });
      addEventListener(Event.EXIT_FRAME, function(_:Event):void {
        if (++n > 4) {
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
