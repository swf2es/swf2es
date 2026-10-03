// Display objects a SWF puts on the stage itself, beside its root, as a
// loader does with the SWF it loads: drawn above and below the root, their
// parent, root and stage, and taken out again by the last frame.
package {
  import flash.display.DisplayObject;
  import flash.display.Sprite;
  import flash.events.Event;

  public class Main extends Sprite {
    private var frame:int = 1;
    private var red:Sprite;
    private var blue:Sprite;

    public function Main() {
      graphics.beginFill(0x00cc00);
      graphics.drawRect(10, 10, 40, 30);
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

    private function describe(name:String, o:DisplayObject):void {
      trace(name, o.parent === stage, o.root === o, o.stage === stage,
        stage.getChildIndex(o) === 0, stage.getChildIndex(o) === stage.numChildren - 1);
    }

    private function enterFrame(e:Event):void {
      frame++;
      if (frame == 2) {
        red = square(0xff0000, 40, 5, 20);
        stage.addChild(red);
        blue = square(0x0000ff, 0, 20, 30);
        stage.addChildAt(blue, 0);
        describe("red", red);
        describe("blue", blue);
        trace("own root", root === this);
      } else if (frame == 3) {
        stage.removeChild(red);
        trace("red removed", red.parent, red.stage, red.root === red);
        blue.x = 60;
        stage.addChildAt(red, 1);
        red.y = 25;
        describe("red again", red);
      } else if (frame == 4) {
        stage.removeChild(red);
        stage.removeChild(blue);
        removeEventListener(Event.ENTER_FRAME, enterFrame);
        trace("cleared");
      }
    }
  }
}
