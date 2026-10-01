// Scripts set one property each of timeline children, and on the next frame
// the timeline places another character at every depth, with no matrix of
// its own. Flash says whether a child is a new object, what it reports of
// its transform, and (in the frame drawn) which untouched Shapes take the
// new shape's graphic; depth 14 is a second untouched control.
package {
  import flash.accessibility.AccessibilityProperties;
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
      try {
        getChildAt(10).name = "named";
      } catch (e:Error) {
        trace("name:", e.errorID);
      }
      getChildAt(11).filters = [];
      getChildAt(12).blendMode = "normal";
      try {
        getChildAt(14).metaData = {};
      } catch (e:Error) {
        trace("metaData:", e.errorID);
      }
      try {
        getChildAt(15).accessibilityProperties = new AccessibilityProperties();
      } catch (e:Error) {
        trace("accessibilityProperties:", e.errorID);
      }
      getChildAt(16).mask = null;
      getChildAt(17).scrollRect = null;
      getChildAt(18).cacheAsBitmap = false;
      getChildAt(19).opaqueBackground = null;
      getChildAt(20).scale9Grid = null;
      getChildAt(21).alpha = 1;
      getChildAt(22).visible = true;
      getChildAt(23).transform.matrix = getChildAt(23).transform.matrix;
      getChildAt(24).cacheAsBitmap = true;
      getChildAt(25).transform.colorTransform = getChildAt(25).transform.colorTransform;
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
