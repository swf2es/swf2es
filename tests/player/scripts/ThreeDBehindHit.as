package {
  import flash.display.Sprite;
  import flash.events.Event;

  // A card behind the eye, which Flash does not draw: no point is on its
  // shape, nor on its child's.
  public class ThreeDBehindHit extends Sprite {
    public function ThreeDBehindHit() {
      var card:Sprite = new Sprite();
      card.graphics.beginFill(0xff0000);
      card.graphics.drawRect(-40, -50, 80, 100);
      var inner:Sprite = new Sprite();
      inner.graphics.beginFill(0x00ff00);
      inner.graphics.drawRect(-10, -10, 20, 20);
      card.addChild(inner);
      card.x = 250;
      card.y = 200;
      card.z = -1000;
      addChild(card);
      addEventListener(Event.ENTER_FRAME, function measure(e:Event):void {
        removeEventListener(Event.ENTER_FRAME, measure);
        var shape:int = 0;
        var innerShape:int = 0;
        for (var x:int = 0; x < 500; x += 5) {
          for (var y:int = 0; y < 400; y += 5) {
            if (card.hitTestPoint(x, y, true)) shape++;
            if (inner.hitTestPoint(x, y, true)) innerShape++;
          }
        }
        trace(shape, innerShape);
      });
    }
  }
}
