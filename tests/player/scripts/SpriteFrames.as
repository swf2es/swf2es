// Sprites of two frames, the first a red square, the second a blue one,
// bound to a class extending Sprite and to one extending MovieClip, placed
// by the root's timeline and made with `new`; the root, whose class extends
// Sprite too, places a green square on its second frame. Flash plays only a
// MovieClip's timeline: a Sprite stays on its first frame, as the
// components of Flash's fl.controls do, whose second frame holds their skins.
package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.events.Event;

  public class SpriteFramesSprite extends Sprite {
  }

  public class SpriteFramesClip extends MovieClip {
  }

  public class SpriteFrames extends Sprite {
    public var placed:SpriteFramesSprite;
    public var placedClip:SpriteFramesClip;
    private var frame:int = 0;
    private var made:SpriteFramesSprite;
    private var madeClip:SpriteFramesClip;

    public function SpriteFrames() {
      made = new SpriteFramesSprite();
      made.x = 20;
      made.y = 60;
      addChild(made);
      madeClip = new SpriteFramesClip();
      madeClip.x = 80;
      madeClip.y = 60;
      addChild(madeClip);
      show();
      addEventListener(Event.ENTER_FRAME, onFrame);
    }

    private function onFrame(e:Event):void {
      if (++frame <= 3) {
        show();
      }
    }

    private function show():void {
      trace("frame", frame, "root", numChildren, placed == getChildByName("placed"),
        placedClip == getChildByName("placedClip"));
      for (var i:int = 0; i < numChildren; i++) {
        var c:DisplayObject = getChildAt(i);
        trace("  ", c.name.indexOf("instance") == 0 ? "made" : c.name, c is MovieClip ? MovieClip(c).currentFrame : "-", c.width);
      }
    }
  }
}
