// BitmapData.draw of a display object with the erase and alpha blends, by
// what Flash traces and draws: unlike a bitmap source's, which they leave
// alone (DrawBitmaps), a display object's take the destination's alpha
// away where it is (erase) or keep only that much of it (alpha), as a game
// digging holes in a bitmap of its ground does. Shapes opaque and half
// transparent, a colour transform, a Bitmap, an opaque destination, each
// traced along a row and shown magnified; then, traced alone: an opaque
// destination half erased, which keeps that alpha and reads it back
// premultiplied; alpha by a clear fill, which leaves the destination, and
// by a clear Bitmap, which clears it; a Bitmap of the destination itself,
// read as it was before the draw; a disc, whose edge Flash erases whole
// rather than by how much of a pixel it covers (where it does is Flash's
// own); a cacheAsBitmap clip scaled by the matrix, as the game's hole is;
// and Bitmaps between pixels.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.MovieClip;
  import flash.display.Shape;
  import flash.display.Loader;
  import flash.display.PNGEncoderOptions;
  import flash.display.Shader;
  import flash.display.ShaderJob;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.ColorTransform;
  import flash.geom.Matrix;
  import flash.geom.Point;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  public class DrawErase extends Sprite {
    private var shown:int = 0;

    public function DrawErase() {
      var square:Shape = block(0x000000, 1);
      trace("erase shape", run(square, null, null, "erase", true, true));
      trace("alpha shape", run(square, null, null, "alpha", true, true));
      trace("erase half", run(block(0xff0000, 0.5), null, null, "erase", true, true));
      trace("alpha half", run(block(0xff0000, 0.5), null, null, "alpha", true, true));
      trace("erase ct", run(square, null, new ColorTransform(1, 1, 1, 0.25), "erase", true, true));
      var pixels:BitmapData = new BitmapData(6, 6, false, 0x0000ff);
      trace("erase Bitmap", run(new Bitmap(pixels), new Matrix(1, 0, 0, 1, 3, 3), null, "erase", true, true));
      trace("erase opaque", run(square, null, null, "erase", false, true));
      trace("alpha opaque", run(square, null, null, "alpha", false, true));
      trace("erase half opaque", run(block(0xff0000, 0.5), null, null, "erase", false, false));
      trace("alpha half opaque", run(block(0xff0000, 0.5), null, null, "alpha", false, false));
      trace("alpha clear shape", run(block(0x000000, 0), null, null, "alpha", true, false));
      trace("alpha clear Bitmap", run(new Bitmap(new BitmapData(6, 6, true, 0)), new Matrix(1, 0, 0, 1, 3, 3), null, "alpha", true, false));
      var split:BitmapData = new BitmapData(6, 6, true, 0xff0000ff);
      split.fillRect(new Rectangle(0, 0, 3, 6), 0);
      trace("alpha split Bitmap", run(new Bitmap(split), new Matrix(1, 0, 0, 1, 3, 3), null, "alpha", true, false));
      trace("erase split Bitmap", run(new Bitmap(split), new Matrix(1, 0, 0, 1, 3, 3), null, "erase", true, false));
      trace("erase self", self("erase"));
      trace("alpha self", self("alpha"));
      readers();

      var disc:Shape = new Shape();
      disc.graphics.beginFill(0x000000);
      disc.graphics.drawCircle(6, 6, 4);
      disc.graphics.endFill();
      trace("erase disc", run(disc, null, null, "erase", true, false));
      var hole:MovieClip = new MovieClip();
      hole.graphics.beginFill(0x333333);
      hole.graphics.drawCircle(0, 0, 10);
      hole.graphics.endFill();
      hole.cacheAsBitmap = true;
      trace("erase cached", run(hole, new Matrix(0.5, 0, 0, 0.5, 7, 6), null, "erase", true, false));
      var half:BitmapData = new BitmapData(6, 6, true, 0x80ff0000);
      trace("erase Bitmap between", run(new Bitmap(pixels), new Matrix(1, 0, 0, 1, 2.5, 3.25), null, "erase", true, false));
      trace("alpha Bitmap between", run(new Bitmap(half), new Matrix(1, 0, 0, 1, 2.5, 3.25), null, "alpha", true, false));
    }

    /** A square from (3, 3) to (9, 9). */
    private function block(color:uint, alpha:Number):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(color, alpha);
      s.graphics.drawRect(3, 3, 6, 6);
      s.graphics.endFill();
      return s;
    }

    /** A row's pixels, as getPixel32 reads them. */
    private static function row(d:BitmapData):String {
      var s:String = "";
      for (var x:int = 0; x < d.width; x++) {
        s += " " + d.getPixel32(x, 0).toString(16);
      }
      return s;
    }

    /**
     * What each reader of an opaque bitmap sees where erase left it less than
     * opaque: green, its second pixel erased whole and its third by half.
     */
    private function readers():void {
      var o:BitmapData = new BitmapData(4, 1, false, 0x33cc66);
      var whole:Shape = new Shape();
      whole.graphics.beginFill(0);
      whole.graphics.drawRect(1, 0, 1, 1);
      o.draw(whole, null, null, "erase");
      var half:Shape = new Shape();
      half.graphics.beginFill(0, 0.5);
      half.graphics.drawRect(2, 0, 1, 1);
      o.draw(half, null, null, "erase");
      trace("opaque getPixel32", row(o));
      trace("opaque getPixel", o.getPixel(1, 0).toString(16), o.getPixel(2, 0).toString(16));

      var bytes:ByteArray = o.getPixels(o.rect);
      var s:String = "";
      bytes.position = 0;
      while (bytes.bytesAvailable) {
        s += " " + bytes.readUnsignedInt().toString(16);
      }
      trace("opaque getPixels", s);
      s = "";
      for each (var v:uint in o.getVector(o.rect)) {
        s += " " + v.toString(16);
      }
      trace("opaque getVector", s);
      trace("opaque clone", row(o.clone()));

      var clean:BitmapData = new BitmapData(4, 1, false, 0x33cc66);
      var difference:Object = o.compare(clean);
      trace("opaque compare", difference is BitmapData ? row(difference as BitmapData) : difference);
      var back:Object = clean.compare(o);
      trace("opaque compared", back is BitmapData ? row(back as BitmapData) : back);

      trace("opaque hitTest", o.hitTest(new Point(), 1, new Point(1, 0)), o.hitTest(new Point(), 255, new Point(2, 0)), o.hitTest(new Point(), 255, new Point(0, 0)));
      trace("opaque hitTest rect", o.hitTest(new Point(), 1, new Rectangle(1, 0, 1, 1)));

      var copied:BitmapData = new BitmapData(4, 1, true, 0);
      copied.copyPixels(o, o.rect, new Point());
      trace("opaque copyPixels", row(copied));
      var merged:BitmapData = new BitmapData(4, 1, true, 0xffff0000);
      merged.copyPixels(o, o.rect, new Point(), null, null, true);
      trace("opaque copyPixels merged", row(merged));
      var drawn:BitmapData = new BitmapData(4, 1, true, 0xffff0000);
      drawn.draw(o);
      trace("opaque draw", row(drawn));
      var drawnBitmap:BitmapData = new BitmapData(4, 1, true, 0xffff0000);
      drawnBitmap.draw(new Bitmap(o));
      trace("opaque draw Bitmap", row(drawnBitmap));

      var filled:BitmapData = o.clone();
      filled.floodFill(1, 0, 0xff0000ff);
      trace("opaque floodFill erased", row(filled));
      filled = o.clone();
      filled.floodFill(0, 0, 0xff0000ff);
      trace("opaque floodFill green", row(filled));

      var copy:Shader = new Shader(new CopyKernel());
      copy.data.src.input = o;
      var shaded:BitmapData = new BitmapData(4, 1, true, 0);
      new ShaderJob(copy, shaded).start(true);
      trace("opaque ShaderJob", row(shaded));

      var png:ByteArray = o.encode(o.rect, new PNGEncoderOptions());
      trace("opaque PNG colour type", png[25]);
      var loader:Loader = new Loader();
      loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function (e:Event):void {
        trace("opaque PNG loaded", row(Bitmap(loader.content).bitmapData));
      });
      loader.loadBytes(png);
    }

    /** A row of rising alphas drawn through a Bitmap of itself, a pixel to the right. */
    private function self(mode:String):String {
      var d:BitmapData = new BitmapData(12, 1, true, 0);
      for (var x:int = 0; x < d.width; x++) {
        d.setPixel32(x, 0, ((x * 20 + 30) << 24 | 0x33cc66) >>> 0);
      }
      d.draw(new Bitmap(d), new Matrix(1, 0, 0, 1, 1, 0), null, mode);
      var s:String = "";
      for (x = 0; x < d.width; x++) {
        s += " " + d.getPixel32(x, 0).toString(16);
      }
      return s;
    }

    /** The source drawn over green, its middle row traced, and the bitmap shown magnified. */
    private function run(source:*, m:Matrix, ct:ColorTransform, mode:String, transparent:Boolean, show:Boolean):String {
      var d:BitmapData = new BitmapData(12, 12, transparent, 0xff33cc66);
      d.draw(source, m, ct, mode);
      if (show) {
        var b:Bitmap = new Bitmap(d);
        b.scaleX = b.scaleY = 4;
        b.x = 2 + (shown % 6) * 52;
        b.y = 2 + int(shown / 6) * 52;
        addChild(b);
        shown++;
      }

      var s:String = "";
      for (var x:int = 0; x < d.width; x++) {
        s += " " + d.getPixel32(x, 6).toString(16);
      }
      return s;
    }
  }
}
