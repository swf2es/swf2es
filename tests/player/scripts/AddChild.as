// The display list changed by a script: a Box (a bound symbol, so it draws)
// added, asked about, removed and added again.
package {
  import flash.display.MovieClip;

  public class Box extends MovieClip {
  }

  public class Main extends MovieClip {
    public function Main() {
      var box:Box = new Box();
      trace("made", box.numChildren, box.parent == null, box.stage == null);
      box.x = 20;
      box.y = 10;
      addChild(box);
      trace("added", numChildren, box.parent == this, getChildIndex(box), box.stage == stage, contains(box));
      var other:Box = new Box();
      addChildAt(other, 0);
      trace("under", numChildren, getChildIndex(box), getChildIndex(other), getChildAt(0) == other);
      removeChild(other);
      trace("removed", numChildren, other.parent == null, getChildIndex(box));
      addChild(box);
      trace("again", numChildren, getChildIndex(box));
    }
  }
}
