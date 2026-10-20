package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.Matrix;

  public class HiddenRenderGroups extends Sprite {
    private var frames:int = 0;
    private var hidden:Sprite = new Sprite();
    private var branch:Sprite = new Sprite();
    private var nested:Sprite = new Sprite();
    private var changing:Shape = new Shape();
    private var clip:Shape = new Shape();

    public function HiddenRenderGroups() {
      addChild(hidden);
      hidden.addChild(branch);
      branch.addChild(nested);
      hidden.x = hidden.y = 10;
      nested.x = 80;
      populate(branch, 0x228844);
      populate(nested, 0x3366cc);
      nested.addChild(changing);
      nested.addChild(clip);
      clip.graphics.beginFill(0);
      clip.graphics.drawRect(0, 0, 24, 22);
      changing.mask = clip;
      paint(0xcc4422);
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function populate(into:Sprite, color:uint):void {
      for (var i:int = 0; i < 70; i++) {
        var dot:Shape = new Shape();
        dot.graphics.beginFill(color);
        dot.graphics.drawRect((i % 10) * 6, 30 + int(i / 10) * 6, 4, 4);
        into.addChild(dot);
      }
    }

    private function paint(color:uint):void {
      changing.graphics.clear();
      changing.graphics.beginFill(color);
      changing.graphics.drawRect(0, 0, 32, 24);
    }

    private function step(event:Event):void {
      frames++;
      switch (frames) {
        case 1:
          hidden.visible = false;
          break;
        case 2:
          branch.removeChildAt(branch.numChildren - 1);
          nested.x = 75;
          clip.x = 4;
          paint(0xffaa00);
          break;
        case 3:
          var pixels:BitmapData = new BitmapData(150, 80, false, 0xffffff);
          pixels.draw(branch, new Matrix());
          var bitmap:Bitmap = new Bitmap(pixels);
          bitmap.x = 180;
          addChild(bitmap);
          trace("bitmap", pixels.getPixel(80, 10));
          break;
        case 4:
          hidden.visible = true;
          break;
        case 5:
          hidden.visible = false;
          paint(0x9922aa);
          addChild(nested);
          nested.y = 100;
          break;
        case 6:
          branch.addChild(nested);
          nested.y = 0;
          break;
        case 7:
          hidden.visible = true;
          break;
      }
    }
  }
}
