package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;

  // Convolutions drawn on display objects as adl draws them: blurs and
  // sharpens of a two-colour square, an emboss, a shift, the edges clamped
  // or coloured, alpha convolved, and how far the filter's region reaches.
  public class ConvolutionDraw extends Sprite {
    private function cell(k:int, filters:Array, alpha:Number = 1, scale:Number = 1):void {
      var x:Number = (k % 6) * 66;
      var y:Number = int(k / 6) * 66;
      graphics.beginFill(0x808080);
      graphics.drawRect(x, y, 64, 64);
      graphics.endFill();
      var s:Shape = new Shape();
      s.graphics.beginFill(0x00aa00, alpha);
      s.graphics.drawRect(0, 0, 24, 24);
      s.graphics.endFill();
      s.graphics.beginFill(0xffcc00, alpha);
      s.graphics.drawRect(6, 6, 9, 12);
      s.graphics.endFill();
      s.x = x + 20;
      s.y = y + 20;
      s.scaleX = s.scaleY = scale;
      s.filters = filters;
      addChild(s);
    }

    public function ConvolutionDraw() {
      cell(0, [new ConvolutionFilter(3, 3, [1, 1, 1, 1, 1, 1, 1, 1, 1], 9)]);
      cell(1, [new ConvolutionFilter(3, 3, [0, -1, 0, -1, 5, -1, 0, -1, 0])]);
      cell(2, [new ConvolutionFilter(3, 3, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 1, 0)]);
      cell(3, [new ConvolutionFilter(3, 3, [1, 0, 0, 0, 0, 0, 0, 0, 0])]);
      cell(4, [new ConvolutionFilter(3, 3, [1, 0, 0, 0, 0, 0, 0, 0, 0], 1, 0, true, false, 0xff0000, 1)]);
      cell(5, [new ConvolutionFilter(5, 5, [
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 25, 0, false)]);
      cell(6, [new ConvolutionFilter(3, 3, [1, 1, 1, 1, 1, 1, 1, 1, 1], 9, 0, false)]);
      cell(7, [new ConvolutionFilter(1, 1, [1], 1, 64, false)]);
      cell(8, [new ConvolutionFilter(3, 3, [0, -1, 0, -1, 5, -1, 0, -1, 0])], 0.5);
      cell(9, [new ConvolutionFilter(3, 3, [0, 0, 0, 0, 0, 0, 0, 0, 1], 1, 0, false, false, 0x0000ff, 0.5)]);
      cell(10, [new ConvolutionFilter(3, 3, [1, 2, 1, 2, 4, 2, 1, 2, 1], 16)], 1, 1.5);
      cell(11, [new ConvolutionFilter(3, 3, [0, 1, 0, 1, -4, 1, 0, 1, 0], 1, 128, false)]);
      trace("drawn");
    }
  }
}
