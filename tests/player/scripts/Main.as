// The first scripted case: a document class on a two-frame root with a
// named child placed on frame 1, tracing what it sees when it is
// constructed and on each frame's script. The child is a declared property,
// as a document class must have for each named child, or be dynamic.
package {
  import flash.display.MovieClip;

  public class Main extends MovieClip {
    // The child named "box" on the timeline: Flash sets it here when it places the child.
    public var box:MovieClip;

    public function Main() {
      // Not `stage`: the oracle runs a SWF as loaded content, constructed before it is on
      // the stage, where a main movie's document class finds the stage set.
      trace("Main", currentFrame, totalFrames, numChildren, box.name, box.x);
      addFrameScript(0, frame1, 1, frame2);
    }

    private function frame1():void {
      trace("frame 1", currentFrame, getChildAt(0).x);
    }

    private function frame2():void {
      trace("frame 2", currentFrame, getChildAt(0).x);
    }
  }
}
