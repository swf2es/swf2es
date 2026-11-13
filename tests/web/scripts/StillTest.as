package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.utils.getTimer;

  // The still test's SWF (still.ts): a box that stands for two seconds, moves
  // once, and stands again. It traces where each part begins and ends, and
  // how many of the first part's frames came sooner or later than a frame
  // of 60 a second does.
  public class StillTest extends Sprite {
    private var _box:Shape = new Shape();
    private var _frames:int = 0;
    private var _last:int = 0;
    private var _early:int = 0;
    private var _late:int = 0;

    public function StillTest() {
      stage.frameRate = 60;
      _box.graphics.beginFill(0xff0000);
      _box.graphics.drawRect(0, 0, 40, 40);
      _box.graphics.endFill();
      _box.x = 10;
      _box.y = 10;
      addChild(_box);
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function frame(e:Event):void {
      const now:int = getTimer();
      const passed:int = now - _last;
      _last = now;
      _frames++;
      if (_frames > 60 && _frames <= 180) {
        if (passed < 8) {
          _early++;
        } else if (passed > 34) {
          _late++;
        }
      }

      switch (_frames) {
        case 60:
          trace("still begin");
          break;
        case 180:
          _box.x = 110;
          trace("still end " + _early + " " + _late);
          break;
        case 181:
          trace("moved");
          break;
        case 240:
          trace("again begin");
          break;
        case 300:
          trace("again end");
          break;
      }
    }
  }
}
