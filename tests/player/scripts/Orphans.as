// Clips off the display list: two a script takes off and keeps one of (a,
// c), one the timeline takes off while its parent's property still names
// it (b), one a script makes with `new` and never adds (made), one made and
// added at once (shown), one made in a frame script (late). Whether their
// timelines and frame scripts go on, when one a script made first advances,
// and what one put back shows. The clips log their frame scripts and the
// root reports at EXIT_FRAME, once every script of the frame has run: the
// order Flash runs orphans' scripts in, among themselves and against the
// display list's, shifts with the case's layout, so the trace must not
// depend on it.
package {
  import flash.display.MovieClip;
  import flash.events.Event;

  public class Clip extends MovieClip {
    /** Each clip's frame scripts so far, as "frame+" on the display list and "frame-" off it. */
    public static var runs:Object = {};

    public function Clip() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3);
    }

    private function ran(frame:int):void {
      runs[name] = (runs[name] || "") + frame + (parent ? "+" : "-");
    }

    private function frame1():void {
      ran(1);
    }

    private function frame2():void {
      ran(2);
    }

    private function frame3():void {
      ran(3);
    }
  }

  public class Main extends MovieClip {
    public var a:Clip;
    public var b:Clip;
    public var c:Clip;
    private var kept:Clip;
    private var keptB:Clip;
    private var made:Clip;
    private var shown:Clip;
    private var late:Clip;

    public function Main() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3, 3, frame4);
      addEventListener(Event.ENTER_FRAME, function(e:Event):void { trace("root enterFrame", currentFrame); });
      addEventListener(Event.EXIT_FRAME, function(e:Event):void { report("exit " + currentFrame); });
      made = new Clip();
      made.name = "made";
      trace("made", made.currentFrame, made.parent == null, made.stage == null);
      shown = new Clip();
      shown.name = "shown";
      shown.x = 120;
      shown.y = 60;
      addChild(shown);
    }

    private function frame1():void {
      kept = a;
      keptB = b;
      removeChild(a);
      removeChild(c);
      late = new Clip();
      late.name = "late";
    }

    private function frame2():void {
      // The timeline took b off: Flash's word on the property that named it.
      trace("b is null", b == null, "a is null", a == null);
    }

    private function frame3():void {
      addChild(c);
    }

    private function frame4():void {
      trace("root frame 4");
    }

    private function report(label:String):void {
      trace("root", label, numChildren, state(kept), state(keptB), state(c), state(made), state(shown), state(late));
    }

    /** name:currentFrame:runs, with the clip's parent as + or -. */
    private static function state(clip:Clip):String {
      return clip.name + ":" + clip.currentFrame + (clip.parent ? "+" : "-") + ":" + (Clip.runs[clip.name] || "");
    }
  }
}
