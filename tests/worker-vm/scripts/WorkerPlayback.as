package {
  import flash.display.BitmapData;
  import flash.display.DisplayObject;
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.filters.BlurFilter;
  import flash.filters.GlowFilter;

  public class WorkerPlayback extends MovieClip {
    private var art:MovieClip;
    private var front:DisplayObject;
    private var bitmap:BitmapData;
    private var frame:int = 0;

    public function WorkerPlayback() {
      art = MovieClip(getChildAt(0));
      front = art.getChildAt(1);
      bitmap = new BitmapData(64, 64, true, 0);
      bitmap.draw(art);
      trace("constructor-pixel:" + bitmap.getPixel32(2, 2).toString(16));
      addEventListener(Event.ENTER_FRAME, animate);
    }

    private function animate(event:Event):void {
      frame++;
      art.x = 30 + frame % 24 * 2;
      art.y = 24;
      art.scaleX = frame % 12 < 6 ? 1 : -1;
      art.filters = frame % 6 < 3 ? [new BlurFilter(2, 2, 1), new GlowFilter(0x33cc66, 0.7, 4, 4)] : [];
      if (frame % 8 == 3) {
        art.swapChildrenAt(0, 1);
      }
      if (frame % 8 == 6) {
        art.removeChild(front);
      }
      if (frame % 8 == 7) {
        art.addChildAt(front, 1);
      }
      if (frame % 8 == 0) {
        bitmap.draw(art);
        trace("frame-pixel:" + bitmap.getPixel32(2, 2).toString(16));
      }
    }
  }
}
