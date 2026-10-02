// BitmapData.draw of a bitmap source, by what Flash traces and draws: the
// exact rules as traces (normal source-over, the matrix's integer moves,
// flips and turns, the colour transform, clipRect, a Bitmap drawn as its
// data with its own transform ignored, alpha and erase doing nothing), and
// what the rasteriser decides (fractional edges, smoothing, the other blend
// modes) as a frame of Bitmaps magnified, compared within a tolerance.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.geom.ColorTransform;
  import flash.geom.Matrix;
  import flash.geom.Rectangle;

  public class Main extends Sprite {
    private var src:BitmapData;
    private var shown:int = 0;

    public function Main() {
      src = new BitmapData(3, 2, true, 0);
      src.setPixel32(0, 0, 0xFFFF0000); src.setPixel32(1, 0, 0x8000FF00); src.setPixel32(2, 0, 0xFF0000FF);
      src.setPixel32(0, 1, 0x40FFFFFF); src.setPixel32(1, 1, 0xFF000000); src.setPixel32(2, 1, 0x00000000);
      trace("plain", run(null, null, null, null, false, 0));
      trace("shift 1,1", run(new Matrix(1, 0, 0, 1, 1, 1), null, null, null, false, 0));
      trace("scale 2", run(new Matrix(2, 0, 0, 2, 0, 0), null, null, null, false, 0));
      trace("flip x", run(new Matrix(-1, 0, 0, 1, 3, 0), null, null, null, false, 0));
      trace("rot 90", run(new Matrix(0, 1, -1, 0, 2, 0), null, null, null, false, 0));
      trace("scale 0.5", run(new Matrix(0.5, 0, 0, 0.5, 0, 0), null, null, null, false, 0));
      trace("ct", run(null, new ColorTransform(0.5, 1, 1, 0.5, 10, 0, 0, 0), null, null, false, 0));
      trace("clip", run(null, null, null, new Rectangle(1, 0, 1, 2), false, 0));
      trace("clip frac", run(null, null, null, new Rectangle(0.6, 0, 1.6, 2), false, 0));
      trace("normal over", run(null, null, "normal", null, false, 0x80336699));
      trace("normal opaque", run(null, null, "normal", null, false, 0xFF336699));
      trace("alpha", run(null, null, "alpha", null, false, 0x80336699));
      trace("erase", run(null, null, "erase", null, false, 0x80336699));
      var opaque:BitmapData = new BitmapData(4, 3, false, 0x336699);
      opaque.draw(src);
      trace("into opaque", dump(opaque));
      var viaBitmap:BitmapData = new BitmapData(4, 3, true, 0);
      viaBitmap.draw(new Bitmap(src), new Matrix(1, 0, 0, 1, 1, 0));
      trace("via Bitmap", dump(viaBitmap));
      var bm:Bitmap = new Bitmap(src); bm.x = 50; bm.scaleX = 3;
      var viaMoved:BitmapData = new BitmapData(4, 3, true, 0);
      viaMoved.draw(bm);
      trace("Bitmap transform ignored", dump(viaMoved));
      try { new BitmapData(1, 1).draw(null); } catch (e:Error) { trace("null", e.errorID); }

      show(new Matrix(1, 0, 0, 1, 0.5, 0), null, null, false, 0);
      show(new Matrix(1, 0, 0, 1, 0.5, 0), null, null, true, 0);
      show(new Matrix(2, 0, 0, 2, 0, 0), null, null, true, 0);
      show(new Matrix(1, 0, 0, 1, 0.49, 0.51), null, null, false, 0);
      for each (var mode:String in ["multiply", "screen", "lighten", "darken", "difference", "add", "subtract", "invert", "overlay", "hardlight"]) {
        show(null, null, mode, false, 0x80336699);
        show(null, null, mode, false, 0xFF336699);
      }
    }

    private function run(m:Matrix, ct:ColorTransform, mode:String, clip:Rectangle, smooth:Boolean, fill:uint):String {
      var d:BitmapData = new BitmapData(4, 3, true, fill);
      d.draw(src, m, ct, mode, clip, smooth);
      return dump(d);
    }

    /** One more drawn bitmap on the stage, magnified 6 times, in a grid. */
    private function show(m:Matrix, ct:ColorTransform, mode:String, smooth:Boolean, fill:uint):void {
      var d:BitmapData = new BitmapData(4, 3, true, fill);
      d.draw(src, m, ct, mode, null, smooth);
      var b:Bitmap = new Bitmap(d);
      b.scaleX = b.scaleY = 6;
      b.x = 2 + (shown % 8) * 26;
      b.y = 2 + int(shown / 8) * 20;
      addChild(b);
      shown++;
    }

    private function dump(d:BitmapData):String {
      var s:String = "";
      for (var y:int = 0; y < d.height; y++) for (var x:int = 0; x < d.width; x++) s += " " + d.getPixel32(x, y).toString(16);
      return s;
    }
  }
}
