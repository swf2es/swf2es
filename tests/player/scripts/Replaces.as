// A script sets a timeline child's scale and rotation; on the next frame
// the timeline replaces the character at that depth with no matrix of its
// own. Flash says what the new child reports: the sign and the angle the
// old one was given, or only what its matrix says.
package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;

  public class Main extends MovieClip {
    private var before:Array = [];

    public function Main() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3);
    }

    private function report(label:String):void {
      for (var i:int = 0; i < numChildren; i++) {
        var c:DisplayObject = getChildAt(i);
        trace(label, i, c, c.scaleX, c.scaleY, c.rotation, c.x, c.y, c.width, c.height, c.transform.matrix);
      }
    }

    private function frame1():void {
      for (var i:int = 0; i < numChildren; i++) {
        before.push(getChildAt(i));
      }
      getChildAt(0).scaleX = -2;
      getChildAt(1).rotation = 90;
      getChildAt(1).scaleX = 2;
      getChildAt(3).scaleX = -2;
      getChildAt(6).scaleX = 2;
      getChildAt(7).rotation = 90;
      getChildAt(8).x = getChildAt(8).x;
      getChildAt(9).scaleX = -2;
      getChildAt(9).rotation = 90;
      report("frame 1");
    }

    private function frame2():void {
      report("frame 2");
    }

    private function frame3():void {
      var same:Array = [];
      for (var i:int = 0; i < numChildren; i++) {
        same.push(before.indexOf(getChildAt(i)) === i);
      }
      trace("frame 3 same objects", same, numChildren);
      report("frame 3");
    }
  }
}
