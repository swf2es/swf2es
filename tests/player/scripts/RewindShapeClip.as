package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;
  import flash.utils.getQualifiedClassName;

  // A rewind to a frame whose place at a depth is another kind of object
  // than the one there now, placed without the move flag at the same
  // ratio: a shape where the frame places a clip, and a clip where it
  // places a shape.
  public class Main extends MovieClip {
    private var before:Array;

    public function Main() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3);
    }

    private function kinds(what:String):Array {
      var out:Array = [];
      for (var i:int = 0; i < numChildren; i++) {
        out.push(getQualifiedClassName(getChildAt(i)));
      }

      trace(what, out.join(" "));
      return [getChildAt(0), getChildAt(1)];
    }

    private function frame1():void {
      kinds("frame 1");
    }

    private function frame2():void {
      before = kinds("frame 2");
    }

    private function frame3():void {
      kinds("frame 3");
      gotoAndStop(1);
      // The goto waits for this script to return, as Flash defers it: the
      // children are still frame 2's here, and frame 1's script shows the
      // rewind's.
      var after:Array = kinds("goto asked");
      trace("still frame 2's", after[0] == before[0], after[1] == before[1]);
    }
  }

  public class A extends MovieClip {
    public function A() {
      trace("A constructor");
    }
  }
}
