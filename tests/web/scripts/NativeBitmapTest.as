package {
  import flash.display.*;
  import flash.filters.ConvolutionFilter;
  import flash.geom.Point;

  public class NativeBitmapTest extends Sprite {
    public function NativeBitmapTest() {
      var source:BitmapData = new BitmapData(16, 16, true, 0x80305070);
      source.setPixel32(8, 8, 0xffff4020);
      var dest:BitmapData = new BitmapData(16, 16, true, 0);
      var f:ConvolutionFilter = new ConvolutionFilter(3, 3, [1, 1, 1, 1, 1, 1, 1, 1, 1], 9);
      dest.applyFilter(source, source.rect, new Point(), f);
      dest.applyFilter(dest, dest.rect, new Point(), f);
      trace(dest.getPixel32(8, 8), dest.getPixel32(0, 0));
      addChild(new Bitmap(dest));
    }
  }
}
