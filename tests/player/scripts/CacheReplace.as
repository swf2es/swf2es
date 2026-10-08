// Objects Flash caches as bitmaps, given another character of the same
// bounds by the timeline on frame 2, and on frame 3 something that may or
// may not make Flash draw them again. Frames 2 to 4 show which draw the
// old graphic. A clip whose cached child was replaced is sent back to its
// first frame: the child is made anew, as the child of another character.
// (adl stops the script, without an error, where a second such clip with
// a larger replacement is sent back, so there is none.)
package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;
  import flash.filters.GlowFilter;
  import flash.geom.ColorTransform;
  import flash.geom.Rectangle;

  public dynamic class Main extends MovieClip {
    private var before:Object = {};

    public function Main() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3, 3, frame4);
    }

    private function o(name:String):Object {
      return getChildByName(name);
    }

    private function frame1():void {
      for (var i:int = 0; i < 10; i++) {
        o("c" + i).cacheAsBitmap = true;
      }
      o("t0").cacheAsBitmap = true;
      o("t1").cacheAsBitmap = true;
      o("t2").cacheAsBitmap = true;
      o("s0").scrollRect = new Rectangle(0, 0, 20, 20);
      o("s1").scrollRect = new Rectangle(0, 0, 30, 30);
      o("s2").opaqueBackground = 0xffffff;
      o("s3").opaqueBackground = 0xffffff;
      o("s4").filters = [new GlowFilter(0, 1, 2, 2)];
      o("s5").filters = [new GlowFilter(0, 1, 2, 2)];
      before.r0 = MovieClip(o("r0")).getChildAt(0);
      before.r0.cacheAsBitmap = true;
    }

    private function frame2():void {
    }

    private function frame3():void {
      o("c2").transform.colorTransform = new ColorTransform(1, 1, 1, 0.5);
      o("c3").scaleX = 1.5;
      o("c4").x += 5;
      o("c5").cacheAsBitmap = false;
      o("c6").cacheAsBitmap = false;
      o("c6").cacheAsBitmap = true;
      trace("c7 width", o("c7").width);
      trace("t1 text", JSON.stringify(o("t1").text));
      trace("t2 width", o("t2").width);
      MovieClip(o("r0")).gotoAndStop(1);
      var c:DisplayObject = MovieClip(o("r0")).getChildAt(0);
      trace("r0 same", c === before.r0, "cached", c.cacheAsBitmap);
    }

    private function frame4():void {
      stop();
    }
  }
}
