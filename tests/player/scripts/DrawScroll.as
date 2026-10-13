// BitmapData.draw of a display object on every frame, each followed by
// operations on the drawn pixels, as a preloader's trail does: scroll,
// whose vacated pixels keep what they held; fillRect, of a part and of the
// whole; copyPixels within the bitmap, as a move and as Flash's smearing
// move down and left, and from other bitmaps, replacing and merged; in
// transparent and opaque bitmaps. In swf2es the draw leaves the pixels on
// the GPU, and the moves and fills that the GPU does exactly keep them
// there for several frames before a read brings them back. The stamp is
// rectangles at whole pixels, so every pixel is exact; the last frame
// traces some of each bitmap.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Matrix;
  import flash.geom.Point;
  import flash.geom.Rectangle;

  public class DrawScroll extends Sprite {
    private var stamp:Shape = new Shape();
    private var scrolled:BitmapData = new BitmapData(48, 48, true, 0);
    private var opaque:BitmapData = new BitmapData(48, 48, false, 0x336699);
    private var copied:BitmapData = new BitmapData(48, 48, true, 0x40ffffff);
    private var smeared:BitmapData = new BitmapData(48, 48, true, 0);
    private var filled:BitmapData = new BitmapData(48, 48, true, 0);
    private var solid:BitmapData = new BitmapData(10, 10, false, 0xffcc00);
    private var faint:BitmapData = new BitmapData(10, 10, true, 0x8000ff00);
    private var frame:int = 0;

    public function DrawScroll() {
      stamp.graphics.beginFill(0xff0000);
      stamp.graphics.drawRect(0, 0, 8, 8);
      stamp.graphics.beginFill(0x0000ff);
      stamp.graphics.drawRect(4, 4, 8, 8);
      stamp.graphics.beginFill(0x00ff00, 0.5);
      stamp.graphics.drawRect(0, 8, 4, 4);

      var all:Array = [scrolled, opaque, copied, smeared, filled];
      for (var i:int = 0; i < all.length; i++) {
        var shown:Bitmap = new Bitmap(all[i]);
        shown.scaleX = shown.scaleY = 2;
        shown.x = 4 + i * 102;
        shown.y = 4;
        addChild(shown);
      }

      addEventListener(Event.ENTER_FRAME, step);
    }

    private function step(e:Event):void {
      frame++;
      var at:Matrix = new Matrix(1, 0, 0, 1, (frame * 7) % 36, 30);

      scrolled.draw(stamp, at);
      scrolled.scroll(0, -3);

      opaque.draw(stamp, at);
      opaque.scroll(2, 1);
      opaque.fillRect(new Rectangle(0, 0, 6, 6), 0x00ff00);

      copied.draw(stamp, at);
      copied.copyPixels(copied, new Rectangle(0, 20, 24, 24), new Point(20, 4));
      copied.copyPixels(solid, solid.rect, new Point(frame * 4, 0));
      copied.copyPixels(faint, faint.rect, new Point(frame * 4, 38), null, null, true);

      smeared.draw(stamp, at);
      smeared.copyPixels(smeared, new Rectangle(8, 20, 24, 24), new Point(2, 24));
      smeared.scroll(-1, 0);

      if (frame % 3 == 1) {
        filled.fillRect(filled.rect, 0x20ff8000);
      }

      filled.draw(stamp, at);
      filled.scroll(3, -2);
      filled.scroll(100, 0);
      filled.scroll(0, 0);

      if (frame == 5) {
        trace("scrolled", row(scrolled, 26), row(scrolled, 20), row(scrolled, 47));
        trace("opaque", row(opaque, 0), row(opaque, 31), row(opaque, 40));
        trace("copied", row(copied, 0), row(copied, 10), row(copied, 30), row(copied, 40));
        trace("smeared", row(smeared, 26), row(smeared, 34), row(smeared, 42));
        trace("filled", row(filled, 0), row(filled, 26), row(filled, 47));
      }
    }

    /** A row's pixels every three, unmultiplied ARGB in hex. */
    private function row(bd:BitmapData, y:int):String {
      var out:Array = [];
      for (var x:int = 0; x < bd.width; x += 3) {
        out.push(bd.getPixel32(x, y).toString(16));
      }

      return out.join(",");
    }
  }
}
