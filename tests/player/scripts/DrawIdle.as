// BitmapData.draw into bitmaps that then go unshown for longer than the
// renderer keeps an idle texture (300 frames): one never shown, read on
// frame 320; one shown at first, taken off, read and shown again on frame
// 320. In swf2es the draw leaves the pixels in the store's texture alone,
// which must outlast the idle frames rather than go with them.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Matrix;

  public class DrawIdle extends Sprite {
    private var hidden:BitmapData = new BitmapData(40, 40, true, 0);
    private var shown:BitmapData = new BitmapData(40, 40, false, 0x336699);
    private var shownBitmap:Bitmap;
    private var frame:int = 0;

    public function DrawIdle() {
      var stamp:Shape = new Shape();
      stamp.graphics.beginFill(0xff0000);
      stamp.graphics.drawRect(0, 0, 16, 16);
      stamp.graphics.beginFill(0x00ff00, 0.5);
      stamp.graphics.drawRect(8, 8, 16, 16);
      hidden.draw(stamp, new Matrix(1, 0, 0, 1, 4, 4));
      shownBitmap = new Bitmap(shown);
      shownBitmap.x = 60;
      addChild(shownBitmap);
      shown.draw(stamp, new Matrix(1, 0, 0, 1, 10, 6));
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function step(e:Event):void {
      frame++;
      if (frame == 2) {
        removeChild(shownBitmap);
      }

      if (frame == 320) {
        trace("hidden", hidden.getPixel32(6, 6).toString(16), hidden.getPixel32(14, 14).toString(16), hidden.getPixel32(26, 26).toString(16), hidden.getPixel32(36, 36).toString(16));
        trace("shown", shown.getPixel32(12, 8).toString(16), shown.getPixel32(20, 16).toString(16), shown.getPixel32(30, 26).toString(16));
        var h:Bitmap = new Bitmap(hidden);
        h.x = 4;
        addChild(h);
        addChild(shownBitmap);
      }
    }
  }
}
