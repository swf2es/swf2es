package {
  import flash.display.*;
  import flash.events.*;
  import flash.geom.Point;

  // Static text as a script reads and hits it: two lines' text, a text
  // that sets no colour, and points on a glyph, between glyphs, and on a
  // glyph drawn transparent, with and without the shape flag. Hit tests
  // need the stage: in adl the root is a Loader's until it is added.
  public class StaticTextProbe extends Sprite {
    public function StaticTextProbe() {
      var lines:Object = getChildAt(0);
      var clear:Object = getChildAt(1);
      trace(JSON.stringify(lines.text), JSON.stringify(clear.text));
      if (stage) {
        hits();
      } else {
        addEventListener(Event.ADDED_TO_STAGE, function (e:Event):void { hits(); });
      }
    }

    private function hits():void {
      var lines:DisplayObject = getChildAt(0);
      var clear:DisplayObject = getChildAt(1);
      var at:Function = function (o:DisplayObject, x:Number, y:Number):String {
        var p:Object = localToGlobal(new Point(x, y));
        return o.hitTestPoint(p.x, p.y, true) + " " + o.hitTestPoint(p.x, p.y, false);
      };
      trace("glyph", at(lines, 45, 35));
      trace("gap", at(lines, 52, 35));
      trace("clear", at(clear, 45, 95));
    }
  }
}
