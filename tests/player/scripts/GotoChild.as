// A parent's frame script jumps to a frame that places a child with a frame
// script of its own: Flash says which script runs first after the jump,
// the parent's for the frame it landed on or the new child's.
package {
  import flash.display.MovieClip;

  public class Inner extends MovieClip {
    public function Inner() {
      addFrameScript(0, frame1);
      trace("Inner made", MovieClip(parent).currentFrame);
    }

    private function frame1():void {
      trace("inner frame 1", MovieClip(parent).currentFrame);
    }
  }

  public class Main extends MovieClip {
    public function Main() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3);
    }

    private function frame1():void {
      trace("root frame 1", numChildren);
      gotoAndStop(3);
      trace("root frame 1 after", currentFrame, numChildren);
    }

    private function frame2():void {
      trace("root frame 2", numChildren);
    }

    private function frame3():void {
      trace("root frame 3", numChildren);
    }
  }
}
