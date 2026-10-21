package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;

  public class Main extends Sprite {
    private var shade:Shape = new Shape();

    public function Main() {
      graphics.beginFill(0x447799);
      graphics.drawRect(0, 0, 256, 192);
      graphics.beginFill(0xFFCC33);
      graphics.drawRect(15, 120, 225, 55);
      graphics.endFill();
      addChild(shade);
      draw(56, 200);
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        removeEventListener(Event.ENTER_FRAME, arguments.callee);
        draw(60, 190);
      });
    }

    private function draw(left:Number, right:Number):void {
      shade.graphics.clear();
      shade.graphics.beginFill(0);
      shade.graphics.drawRect(0, 0, 256, 192);
      for each (var x:Number in [left, right]) {
        shade.graphics.moveTo(x, -64);
        shade.graphics.lineTo(x - 30, 175);
        shade.graphics.lineTo(x + 30, 175);
        shade.graphics.lineTo(x, -64);
      }
      shade.graphics.endFill();
      trace("cones", left, right);
    }
  }
}
