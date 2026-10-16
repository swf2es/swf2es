// What the stage's quality changes, played at each (cases.ts): a disc and a
// skewed square show the edges' anti-aliasing, a smoothed Bitmap and a
// smoothed bitmap fill, both scaled up, whether bitmaps are smoothed, and an
// unsmoothed Bitmap that they are not where it asks for none.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.geom.Matrix;

  public class StageQuality extends Sprite {
    public function StageQuality() {
      const checker:BitmapData = new BitmapData(4, 4, false, 0xffffff);
      for (var y:int = 0; y < 4; y++) {
        for (var x:int = 0; x < 4; x++) {
          if ((x + y) % 2 == 0) {
            checker.setPixel(x, y, 0x3366cc);
          }
        }
      }

      const disc:Shape = new Shape();
      disc.graphics.beginFill(0xcc3333);
      disc.graphics.drawCircle(30, 30, 22);
      disc.graphics.endFill();
      addChild(disc);

      const skewed:Shape = new Shape();
      skewed.graphics.beginFill(0x339933);
      skewed.graphics.drawRect(0, 0, 30, 30);
      skewed.graphics.endFill();
      skewed.transform.matrix = new Matrix(1, 0.3, -0.4, 1, 72, 12);
      addChild(skewed);

      const smoothed:Bitmap = new Bitmap(checker, "auto", true);
      smoothed.x = 120;
      smoothed.y = 6;
      smoothed.scaleX = smoothed.scaleY = 12;
      addChild(smoothed);

      const plain:Bitmap = new Bitmap(checker, "auto", false);
      plain.x = 176;
      plain.y = 6;
      plain.scaleX = plain.scaleY = 12;
      addChild(plain);

      const filled:Shape = new Shape();
      filled.graphics.beginBitmapFill(checker, new Matrix(12, 0, 0, 12, 232, 6), false, true);
      filled.graphics.drawRect(232, 6, 48, 48);
      filled.graphics.endFill();
      addChild(filled);
      trace("drawn");
    }
  }
}
