package {
  import flash.display.Sprite;
  import flash.events.Event;

  public class Plain extends Sprite {
    public var ready:Boolean = false;
    private var _frames:int = 0;

    public function Plain() {
      graphics.beginFill(0x3060c0);
      graphics.drawRect(10, 10, 40, 30);
      graphics.endFill();
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function frame(event:Event):void {
      _frames++;
      ready = _frames >= 10;
    }
  }
}
