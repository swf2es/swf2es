package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.utils.getQualifiedClassName;

  public class PlacedDialog extends MovieClip {
    public var btnA:MovieClip;
    public var sub:MovieClip;
    public var local:MovieClip;
    public var plain:Sprite;

    public function PlacedDialog() {
      super();
      trace("PlacedDialog", numChildren, btnA != null, sub != null, local != null, plain != null);
      for (var i:int = 0; i < numChildren; i++) {
        var child:DisplayObject = getChildAt(i);
        trace(" child", i, child.name, getQualifiedClassName(child), child.x, child.y);
      }
    }
  }
}

package {
  import flash.display.MovieClip;

  public class PlacedLocal extends MovieClip {
    public function PlacedLocal() {
      super();
      trace("PlacedLocal", name, numChildren, parent != null);
    }
  }
}
