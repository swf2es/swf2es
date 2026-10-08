// The timeline puts another character at each depth on frame 2, and back
// on frame 3: Flash says which children stay the same object, what text
// and size a static text reports then, and draws which text each shows.
// Depth 3's text is touched by the script first, and the clip at depth 5
// is sent to the frame that replaces its text.
package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;
  import flash.utils.getQualifiedClassName;

  public class Main extends MovieClip {
    private var before:Array = [];

    public function Main() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3);
    }

    private function report(label:String):void {
      for (var i:int = 0; i < numChildren; i++) {
        var c:Object = getChildAt(i);
        var t:Object = c is MovieClip ? c.getChildAt(0) : c;
        var text:String = "text" in t ? JSON.stringify(t.text) : "-";
        trace(label, i, getQualifiedClassName(c), c === before[i], text, c.width, c.height);
      }
    }

    private function frame1():void {
      for (var i:int = 0; i < numChildren; i++) {
        before.push(getChildAt(i));
      }
      getChildAt(2).x = getChildAt(2).x;
      MovieClip(getChildAt(4)).gotoAndStop(3);
      report("1");
    }

    private function frame2():void {
      report("2");
    }

    private function frame3():void {
      report("3");
      stop();
    }
  }
}
