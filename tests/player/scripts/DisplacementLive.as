package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.*;
  import flash.geom.*;

  // A displacement map changed after objects took it among their filters,
  // while it is shown itself: Flash draws them with the map as it was,
  // moved or not, and with filters set again from their own, which keep it.
  public class DisplacementLive extends Sprite {
    private var map:BitmapData = new BitmapData(25, 25, true, 0xff808080);
    private var still:Shape;
    private var nudged:Shape;
    private var frame:int = 0;
    private function make(x:Number):Shape {
      var s:Shape = new Shape();
      for (var i:int = 0; i < 4; i++) {
        s.graphics.beginFill([0x00aa00, 0xffcc00, 0xcc3300, 0x0033cc][i]);
        s.graphics.drawRect((i % 2) * 12, int(i / 2) * 12, 12, 12);
        s.graphics.endFill();
      }
      s.x = x;
      s.y = 20;
      s.filters = [new DisplacementMapFilter(map, new Point(0, 0), 1, 2, 16, 16)];
      addChild(s);
      return s;
    }
    public function DisplacementLive() {
      still = make(20);
      nudged = make(80);
      var shown:Bitmap = new Bitmap(map);
      shown.x = 110;
      shown.y = 20;
      addChild(shown);
      addEventListener(Event.ENTER_FRAME, tick);
      trace("drawn");
    }
    private function tick(e:Event):void {
      frame++;
      if (frame == 1) {
        // The map changed, the objects not.
        map.fillRect(map.rect, 0xffc0c080);
      } else if (frame == 2) {
        // One object nudged, so that it is drawn again, its filters set from its own.
        nudged.x += 1;
        nudged.filters = nudged.filters;
      }
    }
  }
}
