package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.BlurFilter;

  // Filters set again with the values they had, as a tween writes them on
  // each frame, beside objects that keep theirs: the timeline's at the top
  // move a pixel a frame with their blur written again and without, and
  // stay with it written again; the script's below move a pixel with their
  // filters set from their own and without. Flash draws them alike.
  public class FilterRetween extends MovieClip {
    private var reset:Sprite;
    private var kept:Sprite;

    private function square(x:Number):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(0x0033cc);
      s.graphics.drawRect(0, 0, 20, 20);
      s.graphics.endFill();
      s.x = x;
      s.y = 32;
      s.filters = [new BlurFilter(2, 2, 1)];
      addChild(s);
      return s;
    }

    public function FilterRetween() {
      reset = square(10);
      kept = square(60);
      addEventListener(Event.ENTER_FRAME, tick);
      trace("drawn");
    }

    private function tick(e:Event):void {
      if (currentFrame == 1) {
        return;
      }

      reset.x += 1;
      reset.filters = reset.filters;
      kept.x += 1;
      if (currentFrame == 4) {
        removeEventListener(Event.ENTER_FRAME, tick);
        trace("done");
      }
    }
  }
}
