package {
  import flash.display.*;
  import flash.filters.*;

  // Filters on objects that draw nothing, as adl draws them: an empty
  // sprite and a sprite holding only an empty one, most filters' cells with
  // a 2 by 2 square beside them, filtered alike, that shows it draws. (Not
  // a shadow's, a bevel's or a colour matrix's, whose edges on so small a
  // square part from adl's, which is not what this case is about.)
  public class FiltersEmpty extends Sprite {
    private function cell(k:int, filters:Array, control:Boolean = true):void {
      var x:Number = (k % 5) * 66;
      var y:Number = int(k / 5) * 66;
      graphics.beginFill(0x808080);
      graphics.drawRect(x, y, 64, 64);
      graphics.endFill();
      var empty:Sprite = new Sprite();
      empty.x = x + 12;
      empty.y = y + 32;
      empty.filters = filters;
      addChild(empty);
      var holder:Sprite = new Sprite();
      holder.x = x + 32;
      holder.y = y + 32;
      holder.addChild(new Sprite());
      holder.filters = filters;
      addChild(holder);
      if (!control) {
        return;
      }

      var square:Shape = new Shape();
      square.graphics.beginFill(0x00aa00);
      square.graphics.drawRect(0, 0, 2, 2);
      square.graphics.endFill();
      square.x = x + 51;
      square.y = y + 31;
      square.filters = filters;
      addChild(square);
    }

    public function FiltersEmpty() {
      cell(0, [new GlowFilter(0xff0000, 1, 4, 4, 4, 1)]);
      cell(1, [new GlowFilter(0xff0000, 1, 4, 4, 4, 1, false, true)]);
      cell(2, [new GlowFilter(0xffff00, 1, 4, 4, 4, 1, true)]);
      cell(3, [new DropShadowFilter(6, 45, 0, 1, 2, 2, 4, 1)], false);
      cell(4, [new BlurFilter(4, 4, 1)]);
      cell(5, [new BevelFilter(3, 45, 0xffffff, 1, 0, 1, 2, 2, 4)], false);
      cell(6, [new GradientGlowFilter(0, 45, [0xff0000, 0x0000ff], [0, 1], [0, 255], 4, 4, 4)]);
      cell(7, [new ColorMatrixFilter([0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255])], false);
      cell(8, [new ConvolutionFilter(1, 1, [1], 1, 200, false)]);
      cell(9, [new BlurFilter(2, 2, 1), new GlowFilter(0xff00ff, 1, 4, 4, 4, 1)]);
      trace("drawn");
    }
  }
}
