package {
  import flash.display.*;

  public class BlendDirect extends Sprite {
    private function rect(s:Sprite, color:uint, alpha:Number, x:Number, y:Number):void {
      s.graphics.beginFill(color, alpha);
      s.graphics.drawRect(x, y, 50, 60);
      s.graphics.endFill();
    }

    public function BlendDirect() {
      graphics.beginFill(0x806040);
      graphics.drawRect(0, 0, 160, 80);
      graphics.endFill();

      var multiply:Sprite = new Sprite();
      rect(multiply, 0x40c0ff, 0.6, 10, 10);
      multiply.blendMode = "multiply";
      addChild(multiply);

      var screen:Sprite = new Sprite();
      rect(screen, 0x904020, 0.5, 90, 10);
      screen.blendMode = "screen";
      addChild(screen);
      trace("drawn");
    }
  }
}
