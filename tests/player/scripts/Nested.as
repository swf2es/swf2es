// A clip inside a clip, each with a frame script tracing its frame: the
// order Flash runs them in, frame by frame, is the order the player must
// advance nested timelines in.
package {
  import flash.display.MovieClip;

  public class Inner extends MovieClip {
    public function Inner() {
      addFrameScript(0, frame1, 1, frame2);
      trace("Inner made", currentFrame);
    }

    private function frame1():void {
      trace("inner frame 1", currentFrame, MovieClip(parent).currentFrame);
    }

    private function frame2():void {
      trace("inner frame 2", currentFrame, MovieClip(parent).currentFrame);
    }
  }

  public class Main extends MovieClip {
    public function Main() {
      addFrameScript(0, frame1, 1, frame2);
      trace("Main made", currentFrame, MovieClip(getChildAt(0)).currentFrame);
    }

    private function frame1():void {
      trace("root frame 1", currentFrame, MovieClip(getChildAt(0)).currentFrame);
    }

    private function frame2():void {
      trace("root frame 2", currentFrame, MovieClip(getChildAt(0)).currentFrame);
    }
  }
}
