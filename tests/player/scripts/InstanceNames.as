// The names Flash gives display objects nobody named: timeline children's,
// named and not, one inside a sprite, those a script makes with new, and
// one the timeline places a frame later. The count is the player's, which
// the harness's own objects share, so numbers print from the first child's;
// the root, a loaded SWF's here and the main SWF's root1 in a player, apart.
package {
  import flash.display.*;
  import flash.events.Event;
  import flash.text.TextField;

  public class Main extends MovieClip {
    public var a:MovieClip;
    private var step:int = 0;

    private var base:int = -1;

    /** instanceN as instance+K from the first child's N; any other name as it is. */
    private function rel(name:String):String {
      var m:Array = name.match(/^instance(\d+)$/);
      if (!m) {
        return name;
      }

      if (base < 0) {
        base = int(m[1]);
      }

      return "instance+" + (int(m[1]) - base);
    }

    public function Main() {
      trace("root", name.match(/^(root|instance)\d+$/) ? "named" : name);
      for (var i:int = 0; i < numChildren; i++) {
        var c:DisplayObject = getChildAt(i);
        trace("child", i, rel(c.name), c is DisplayObjectContainer
          ? DisplayObjectContainer(c).numChildren + " " + (DisplayObjectContainer(c).numChildren
            ? rel(DisplayObjectContainer(c).getChildAt(0).name) : "")
          : "");
      }

      trace("new", rel(new Sprite().name), rel(new Shape().name), rel(new MovieClip().name));
      trace("new", rel(new TextField().name), rel(new Bitmap().name), rel(new Loader().name));
      // At EXIT_FRAME: at ENTER_FRAME Flash has not yet made the AS3 object of
      // a child the frame places, and getChildAt gives null for it.
      addEventListener(Event.EXIT_FRAME, function(_:Event):void {
        if (++step == 2) {
          var placed:DisplayObjectContainer = DisplayObjectContainer(getChildAt(numChildren - 1));
          trace("frame 2", numChildren, rel(placed.name), rel(placed.getChildAt(0).name),
            rel(new Sprite().name));
        }
      });
    }
  }
}
