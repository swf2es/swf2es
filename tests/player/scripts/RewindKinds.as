// A rewind past moves that give children placed on the first frame another
// ratio, a shape, a morph, a text field and a clip, beside a shape placed
// again later with another ratio and one placed again with the same; frame
// 3's script sends the root back to frame 1. Main traces, for each child,
// whether it is the object the frame before showed there ("kept") or
// another ("new").
package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.utils.getQualifiedClassName;

  public class A extends MovieClip {
    public function A() { trace("made A"); }
  }

  public class Main extends MovieClip {
    private var back:Boolean = false;
    private var n:int = 0;
    private var before:Array = [];

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
        var now:Array = [];
        for (var i:int = 0; i < numChildren; i++) {
          var c:DisplayObject = getChildAt(i);
          now.push(c);
          out.push(getQualifiedClassName(c) + "@" + c.x + (c === before[i] ? " kept" : " new"));
        }

        before = now;
        trace("frame " + currentFrame, out.join(", "));
      });
    }
  }
}
