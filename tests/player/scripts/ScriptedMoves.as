// A script touches one property of each timeline child on frame 1, most set
// to what they were; frames 2 to 4 move every child with a matrix, a colour
// transform, filters, a blend mode and visibility, and the root then loops
// to frame 1, whose places the children take again. Flash says which of
// the moves' properties a touched child still takes, and whether the loop
// gives it its first place's transform back. Child 0 is the control, and
// the last two are MorphShapes, whose ratio the moves change, the first of
// them touched, which the frames drawn show; widths are left out, as in
// adl a morph's stays its first blend's even once another is drawn.
package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;
  import flash.geom.ColorTransform;

  public class Main extends MovieClip {
    private var pass:int = 0;

    public function Main() {
      addFrameScript(0, frame1, 1, report, 2, report, 3, report, 4, report);
    }

    private function frame1():void {
      pass++;
      if (pass == 1) {
        touch();
      }
      report();
    }

    private function touch():void {
      var c:DisplayObject;
      c = getChildAt(1); c.x = c.x;
      c = getChildAt(2); c.alpha = c.alpha;
      c = getChildAt(3); c.transform.colorTransform = c.transform.colorTransform;
      c = getChildAt(4); c.transform.matrix = c.transform.matrix;
      c = getChildAt(5); c.blendMode = c.blendMode;
      c = getChildAt(6); c.filters = c.filters;
      c = getChildAt(7); c.visible = c.visible;
      c = getChildAt(8); c.visible = false;
      c = getChildAt(9); c.cacheAsBitmap = true;
      c = getChildAt(10); c.rotation = c.rotation;
      c = getChildAt(11); c.width = c.width;
      c = getChildAt(12); c.scrollRect = c.scrollRect;
      c = getChildAt(13); c.mask = null;
      c = getChildAt(14); c.opaqueBackground = c.opaqueBackground;
      c = getChildAt(15); c.y = c.y;
      c = getChildAt(16); c.scaleX = c.scaleX;
      c = getChildAt(17); c.height = c.height;
      c = getChildAt(18); c.scale9Grid = c.scale9Grid;
      c = getChildAt(19); c.transform = c.transform;
      c = getChildAt(20); c.x += 5;
      c = getChildAt(21); c.alpha = 0.5;
      c = getChildAt(22); c.cacheAsBitmap = false;
      c = getChildAt(23); c.x = c.x;
    }

    private function report():void {
      if (pass > 2) {
        return;
      }

      trace("pass " + pass + " frame " + currentFrame);
      for (var i:int = 0; i < numChildren; i++) {
        var c:DisplayObject = getChildAt(i);
        var t:ColorTransform = c.transform.colorTransform;
        trace(" ", i, c.x, c.scaleX, t.redMultiplier, t.alphaMultiplier, t.redOffset,
          c.blendMode, c.filters.length, c.visible);
      }
      if (pass == 2 && currentFrame == 2) {
        pass++;
      }
    }
  }
}
