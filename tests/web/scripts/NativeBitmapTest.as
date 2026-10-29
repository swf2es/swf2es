package {
  import flash.display.*;
  import flash.filters.BlurFilter;
  import flash.filters.ConvolutionFilter;
  import flash.filters.GlowFilter;
  import flash.geom.Point;

  public class NativeBitmapTest extends Sprite {
    public function NativeBitmapTest() {
      var source:BitmapData = new BitmapData(16, 16, true, 0x80305070);
      source.setPixel32(8, 8, 0xffff4020);
      var dest:BitmapData = new BitmapData(16, 16, true, 0);
      var f:ConvolutionFilter = new ConvolutionFilter(3, 3, [1, 1, 1, 1, 1, 1, 1, 1, 1], 9);
      dest.applyFilter(source, source.rect, new Point(), f);
      dest.applyFilter(dest, dest.rect, new Point(), f);
      dest.applyFilter(dest, dest.rect, new Point(), new BlurFilter(4, 4, 1));
      dest.applyFilter(dest, dest.rect, new Point(), new GlowFilter(0xff0000, 1, 4, 4, 2, 1));
      trace(dest.getPixel32(8, 8), dest.getPixel32(0, 0));
      addChild(new Bitmap(dest));
    }
  }
}
