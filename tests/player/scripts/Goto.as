// A goto from a frame script: frame 2's script jumps to frame 4 and stops.
// Flash says whether frame 4's script runs in the same phase, what
// currentFrame reads right after the jump, and (in the frame drawn) that
// the child is where frame 4 puts it.
package {
  import flash.display.MovieClip;

  public class Main extends MovieClip {
    public function Main() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3, 3, frame4);
    }

    private function frame1():void {
      trace("frame 1", currentFrame, getChildAt(0).x);
    }

    private function frame2():void {
      trace("frame 2 before", currentFrame, getChildAt(0).x);
      gotoAndStop(4);
      trace("frame 2 after", currentFrame, getChildAt(0).x);
    }

    private function frame3():void {
      trace("frame 3", currentFrame, getChildAt(0).x);
    }

    private function frame4():void {
      trace("frame 4", currentFrame, getChildAt(0).x, isPlaying);
    }
  }
}
