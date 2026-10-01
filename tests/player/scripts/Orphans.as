// Clips taken off the display list, two by a script that keeps one and
// one by the timeline while its parent's property still names it: whether
// their timelines and frame scripts go on, in what order, and what one put
// back shows.
package {
  import flash.display.MovieClip;
  import flash.events.Event;

  public class Clip extends MovieClip {
    public function Clip() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3);
    }

    private function frame1():void {
      trace(name, "frame 1", parent != null, stage != null);
    }

    private function frame2():void {
      trace(name, "frame 2", parent != null, stage != null);
    }

    private function frame3():void {
      trace(name, "frame 3", parent != null, stage != null);
    }
  }

  public class Main extends MovieClip {
    public var a:Clip;
    public var b:Clip;
    public var c:Clip;
    private var kept:Clip;
    private var keptB:Clip;

    public function Main() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3, 3, frame4);
      addEventListener(Event.ENTER_FRAME, function(e:Event):void { trace("root enterFrame", currentFrame); });
    }

    private function frame1():void {
      kept = a;
      keptB = b;
      // a then c, of depths 1 and 3, so that the order their scripts run in tells what orders them.
      removeChild(a);
      removeChild(c);
      trace("root frame 1", numChildren, a == null, kept.currentFrame, b.currentFrame);
    }

    private function frame2():void {
      // The timeline took b off: Flash's word on the property that named it.
      trace("root frame 2", numChildren, kept.currentFrame, kept.parent == null, b == null, keptB.currentFrame, keptB.parent == null);
    }

    private function frame3():void {
      addChild(kept);
      trace("root frame 3", numChildren, kept.currentFrame, keptB.currentFrame);
    }

    private function frame4():void {
      trace("root frame 4", numChildren, kept.currentFrame, keptB.currentFrame);
    }
  }
}
