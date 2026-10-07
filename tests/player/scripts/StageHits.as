// A sprite a SWF puts on the stage itself, beside its root, as a window over
// the whole movie is: what hitTestPoint answers for it and for what is in it,
// with and without the shape test, beside one in no display list with the
// shape test, and which of them are under the point.
package {
  import flash.display.DisplayObject;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Point;

  public class StageHits extends Sprite {
    public function StageHits() {
      addEventListener(Event.ENTER_FRAME, enterFrame);
    }

    private static function square(color:uint, x:Number, y:Number, size:Number):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(color);
      s.graphics.drawRect(0, 0, size, size);
      s.x = x;
      s.y = y;
      return s;
    }

    private function enterFrame(e:Event):void {
      removeEventListener(Event.ENTER_FRAME, enterFrame);
      var window:Sprite = square(0xff0000, 20, 10, 40);
      window.name = "window";
      var inner:Shape = new Shape();
      inner.name = "inner";
      inner.graphics.beginFill(0x0000ff);
      inner.graphics.drawRect(0, 0, 10, 10);
      inner.x = 30;
      inner.y = 5;
      window.addChild(inner);
      stage.addChild(window);
      var off:Sprite = square(0x00ff00, 20, 10, 40);

      trace("window root", window.root === window, window.root === stage, window.root === this,
        "loaderInfo", window.loaderInfo === stage.loaderInfo, window.loaderInfo === null,
        "stage root", stage.root === stage);
      for each (var p:Array in [[30, 20], [55, 20], [70, 20]]) {
        trace(p, "window", window.hitTestPoint(p[0], p[1], true), window.hitTestPoint(p[0], p[1]),
          "inner", inner.hitTestPoint(p[0], p[1], true), inner.hitTestPoint(p[0], p[1]),
          "off", off.hitTestPoint(p[0], p[1], true),
          "stage", stage.hitTestPoint(p[0], p[1], true), stage.hitTestPoint(p[0], p[1]));
        var names:Array = [];
        for each (var d:DisplayObject in stage.getObjectsUnderPoint(new Point(p[0], p[1]))) {
          if (d.name == "window" || d.name == "inner") {
            names.push(d.name);
          }
        }

        trace("  under", names);
      }
    }
  }
}
