package {
  import flash.display.Graphics;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;

  public class Main extends Sprite {
    private var shade:Shape = new Shape();
    private var frame:int = 0;

    public function Main() {
      graphics.beginFill(0x447799);
      graphics.drawRect(0, 0, 256, 192);
      graphics.beginFill(0xFFCC33);
      graphics.drawRect(15, 120, 225, 55);
      graphics.endFill();
      addChild(shade);
      draw();
      trace("zoomed cones");
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function step(event:Event):void {
      frame++;
      draw();
      if (frame == 60) {
        removeEventListener(Event.ENTER_FRAME, step);
      }
    }

    private function draw():void {
      var g:Graphics = shade.graphics;
      g.clear();
      g.beginFill(0);
      g.drawRect(0, 0, 256, 192);
      var points:Array = [56, -64, 88, 175, 168, 175, 200, -64, 128, 123.04347826086956, 56, -64];
      var scale:Number = 1 + frame / 60;
      for (var i:int = 0; i < points.length; i += 2) {
        var x:Number = points[i] * scale - 134 * (scale - 1);
        var y:Number = points[i + 1] * scale - 194 * (scale - 1);
        if (i == 0) {
          g.moveTo(x, y);
        } else {
          g.lineTo(x, y);
        }
      }
      g.endFill();
    }
  }
}
