// Shadows cast hundreds of pixels from small objects, as AS3 may set them
// past what the authoring tools offer: each drawn whole, its padding as far
// as it reaches, where the texture it asks for fits the GPU.
package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.filters.BevelFilter;
  import flash.filters.DropShadowFilter;

  public class Main extends Sprite {
    public function Main() {
      square(10, 6, [new DropShadowFilter(400, 0, 0x0000ff, 1, 0, 0, 1, 1)]);
      square(10, 26, [new DropShadowFilter(300, 0, 0x000000, 1, 4, 4, 1, 1)]);
      square(440, 46, [new DropShadowFilter(420, 180, 0x008000, 1, 0, 0, 1, 1, false, false, true)]);
      square(200, 46, [new BevelFilter(260, 0, 0xffff00, 1, 0x0000ff, 1, 0, 0, 1, 1, "outer")]);
      trace("shadows", numChildren);
    }

    private function square(x:Number, y:Number, filters:Array):void {
      var s:Shape = new Shape();
      s.graphics.beginFill(0xff0000);
      s.graphics.drawRect(0, 0, 10, 10);
      s.x = x;
      s.y = y;
      s.filters = filters;
      addChild(s);
    }
  }
}
