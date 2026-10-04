package {
  import flash.display.*;
  import flash.events.*;
  import flash.geom.ColorTransform;

  // Two clips of one shape and one static text: the first is brightened by
  // a colour transform on frame 2, as a button's over state is, and has it
  // taken off on frame 3. The second, never transformed, draws throughout.
  public class SharedColors extends Sprite {
    private var frame:int = 1;

    public function SharedColors() {
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function step(e:Event):void {
      frame++;
      var first:DisplayObject = getChildAt(0);
      if (frame == 2) {
        first.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 60, 60, 60, 0);
      } else if (frame == 3) {
        first.transform.colorTransform = new ColorTransform();
        removeEventListener(Event.ENTER_FRAME, step);
      }

      trace(frame, first.transform.colorTransform.redOffset);
    }
  }
}
