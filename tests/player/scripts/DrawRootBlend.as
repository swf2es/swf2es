// BitmapData.draw of objects whose own blend mode is not normal: Flash
// draws the source "with no matrix transform, no color transformation, and
// no blend mode", so an erase, alpha, multiply or invert sprite is drawn
// as if normal, while a child's blend mode inside it still blends. Each is
// drawn into a transparent bitmap and an opaque one; the last row has the
// child blended, by channels of 0 and 255 so that its product is exact.
// Rectangles at whole pixels; the trace reads the centres of the
// transparent bitmaps.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;

  public class DrawRootBlend extends Sprite {
    private static const MODES:Array = ["erase", "alpha", "multiply", "invert", "layer"];

    private function square(color:uint, alpha:Number, size:int):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(color, alpha);
      s.graphics.drawRect(0, 0, size, size);
      s.graphics.endFill();
      return s;
    }

    public function DrawRootBlend() {
      graphics.beginFill(0x808080);
      graphics.drawRect(0, 0, 320, 120);
      graphics.endFill();
      for (var i:int = 0; i < MODES.length; i++) {
        var source:Sprite = new Sprite();
        source.addChild(square(0xcc3300, 0.75, 24));
        source.blendMode = MODES[i];
        var nested:Sprite = new Sprite();
        nested.addChild(square(0x3366cc, 1, 24));
        var child:Shape = square(0xff00ff, 1, 12);
        child.x = 6;
        child.y = 6;
        child.blendMode = "multiply";
        nested.addChild(child);
        nested.blendMode = MODES[i];
        var rows:Array = [
          [new BitmapData(32, 32, true, 0), source],
          [new BitmapData(32, 32, false, 0x336699), source],
          [new BitmapData(32, 32, true, 0), nested],
        ];
        for (var r:int = 0; r < rows.length; r++) {
          var bitmap:BitmapData = rows[r][0];
          bitmap.draw(rows[r][1]);
          var shown:Bitmap = new Bitmap(bitmap);
          shown.x = 8 + i * 62;
          shown.y = 4 + r * 38;
          addChild(shown);
          // The opaque one's source over rounds a level apart on the GPU, which its picture allows.
          if (r != 1) {
            trace(MODES[i] + " " + r + " " + bitmap.getPixel32(12, 12).toString(16));
          }
        }
      }
    }
  }
}
