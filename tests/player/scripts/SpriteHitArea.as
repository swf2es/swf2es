package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Point;

  // Sprite.hitArea and dropTarget as scripts read them: the area kept as
  // set, its own mouseEnabled and mouseChildren left alone, the hit tests
  // a script asks ignoring it, and no drop target before a drag.
  public class SpriteHitArea extends Sprite {
    public function SpriteHitArea() {
      var button:Sprite = square(0, 0);
      var area:Sprite = square(50, 50);
      addChild(button);
      addChild(area);
      trace("unset", button.hitArea, button.dropTarget);
      button.hitArea = area;
      trace("set", button.hitArea == area, area.hitArea, area.mouseEnabled, area.mouseChildren);
      area.visible = false;
      trace("hidden", button.hitArea == area);
      button.hitArea = button;
      trace("itself", button.hitArea == button);
      button.hitArea = null;
      trace("cleared", button.hitArea);
      var other:Sprite = new Sprite();
      other.hitArea = area;
      button.hitArea = area;
      trace("shared", other.hitArea == area, button.hitArea == area);
      area.visible = true;
      // Once drawn: Flash's hit tests find nothing in the constructor.
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        removeEventListener(Event.ENTER_FRAME, arguments.callee);
        trace("hitTestPoint", button.hitTestPoint(60, 60, true), button.hitTestPoint(60, 60, false),
          button.hitTestPoint(10, 10, true));
        trace("under", getObjectsUnderPoint(new Point(60, 60)).length,
          getObjectsUnderPoint(new Point(10, 10)).length);
      });
    }

    private function square(x:Number, y:Number):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(0x3366cc);
      s.graphics.drawRect(0, 0, 20, 20);
      s.x = x;
      s.y = y;
      return s;
    }
  }
}
