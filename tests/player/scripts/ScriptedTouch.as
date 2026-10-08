// Scripts set one property each of timeline children on frame 1, each to
// a value it did not have, and on frame 2 the timeline puts another
// character in each one's place with the move flag: a larger square where
// a square was, another text where a text was. Flash says which children
// take the new character, by their sizes and text, and draws them.
package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;

  public class Main extends MovieClip {
    public function Main() {
      addFrameScript(0, frame1, 1, frame2);
    }

    private function report(label:String):void {
      for (var i:int = 0; i < 14; i++) {
        var c:Object = getChildAt(i);
        var text:String = "text" in c ? JSON.stringify(c.text) : "-";
        trace(label, i, c.width, c.height, text, c.visible, c.cacheAsBitmap, c.mask != null, c.blendMode);
      }
    }

    // Children 0 to 6 are squares, 7 to 13 texts; 14 and 15 are masks. 16 and 17 are
    // squares whose replacement is as large, the second cached as a bitmap.
    private function touch(first:int):void {
      getChildAt(first + 1).visible = false;
      getChildAt(first + 2).cacheAsBitmap = true;
      getChildAt(first + 3).mask = getChildAt(first === 0 ? 14 : 15);
      getChildAt(first + 4).blendMode = "normal";
      getChildAt(first + 5).blendMode = "multiply";
      getChildAt(first + 6).visible = false;
      getChildAt(first + 6).visible = true;
    }

    private function frame1():void {
      touch(0);
      touch(7);
      getChildAt(17).cacheAsBitmap = true;
      report("1");
    }

    private function frame2():void {
      report("2");
      stop();
    }
  }
}
