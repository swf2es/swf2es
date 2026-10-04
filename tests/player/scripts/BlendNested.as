package {
  import flash.display.*;
  import flash.filters.BlurFilter;
  import flash.geom.ColorTransform;

  // Blurred objects added in a layer that is itself added to what is below:
  // the inner blend's region, grown by its blur, begins left of and above
  // the layer's, so what is behind it there is nothing of the layer's. Each
  // inner object is coloured by a transform's offsets alone, and the outer
  // ones are mirrored, as a character's flame is drawn facing left. Opaque
  // grounds whose sums are exact, axis-aligned shapes on whole pixels and
  // a blur of whole pixels, so the stage is drawn as Flash draws it.
  public class BlendNested extends Sprite {
    private function rect(g:Graphics, color:uint, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    private function nested(x:Number, y:Number, mirrored:Boolean, blur:Number, color:uint):Sprite {
      var outer:Sprite = new Sprite();
      outer.blendMode = "add";
      outer.x = x;
      outer.y = y;
      if (mirrored) {
        outer.scaleX = -1;
      }

      var inner:Sprite = new Sprite();
      rect(inner.graphics, 0x808080, 0, 0, 40, 30);
      rect(inner.graphics, 0xffffff, 10, 10, 20, 10);
      inner.x = 5;
      inner.y = 6;
      inner.blendMode = "add";
      inner.filters = [new BlurFilter(blur, blur, 1)];
      inner.transform.colorTransform = new ColorTransform(
        0, 0, 0, 1, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff, 0);
      outer.addChild(inner);
      addChild(outer);
      return outer;
    }

    public function BlendNested() {
      var ground:Shape = new Shape();
      for (var i:int = 0; i < 12; i++) {
        rect(ground.graphics, i % 2 ? 0x204060 : 0x604020, i * 20, 0, 20, 120);
      }
      for (var j:int = 0; j < 6; j++) {
        rect(ground.graphics, 0x103010, 0, j * 20 + 10, 240, 4);
      }
      addChild(ground);

      nested(10, 10, false, 8, 0x0066ff);
      nested(110, 10, true, 4, 0xff9900);
      nested(130, 60, false, 16, 0x40c040);
      nested(230, 60, true, 2, 0xc040c0);
      trace("drawn");
    }
  }
}
