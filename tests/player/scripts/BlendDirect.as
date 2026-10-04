package {
  import flash.display.*;
  import flash.events.Event;

  public class BlendDirect extends Sprite {
    private function rect(s:Sprite, color:uint, alpha:Number, x:Number, y:Number):void {
      s.graphics.beginFill(color, alpha);
      s.graphics.drawRect(x, y, 50, 60);
      s.graphics.endFill();
    }

    public function BlendDirect() {
      graphics.beginFill(0x806040);
      graphics.drawRect(0, 0, 240, 80);
      graphics.endFill();

      var multiply:Sprite = new Sprite();
      var multiplyFill:Sprite = new Sprite();
      rect(multiplyFill, 0x40c0ff, 0.6, 0, 0);
      multiplyFill.blendMode = "multiply";
      multiply.addChild(multiplyFill);
      multiply.x = 10;
      multiply.y = 10;
      addChild(multiply);

      var inherited:Sprite = new Sprite();
      var inheritedFill:Sprite = new Sprite();
      rect(inheritedFill, 0x40c0ff, 0.6, 0, 0);
      inherited.addChild(inheritedFill);
      inherited.x = 90;
      inherited.y = 10;
      inherited.blendMode = "multiply";
      addChild(inherited);

      var screen:Sprite = new Sprite();
      rect(screen, 0x904020, 0.5, 0, 0);
      screen.x = 170;
      screen.y = 10;
      screen.blendMode = "screen";
      addChild(screen);

      var frame:int = 0;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        frame++;
        if (frame == 2) {
          multiply.blendMode = "layer";
          inheritedFill.blendMode = "multiply";
        } else if (frame == 3) {
          multiply.blendMode = "normal";
          inheritedFill.blendMode = "normal";
        }
      });
      trace("drawn");
    }
  }
}
