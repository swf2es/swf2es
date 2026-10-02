package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.*;

  public dynamic class ClipDepths extends MovieClip {
    private function box(color:uint, x:Number, y:Number, w:Number, h:Number):Sprite {
      var r:Sprite = new Sprite();
      r.graphics.beginFill(color);
      r.graphics.drawRect(x, y, w, h);
      return r;
    }

    public function ClipDepths() {
      var mA:DisplayObject = getChildByName("mA");
      trace("children", numChildren, "mA.mask", mA.mask, "rA.mask", getChildByName("rA").mask, "mA.visible", mA.visible);
      trace("mA bounds", mA.getBounds(this), "rA width", getChildByName("rA").width, "this width", width);
      var black:Sprite = box(0, 100, 25, 100, 50);
      addChildAt(black, getChildIndex(getChildByName("bB")));
      trace("inserted at", getChildIndex(black), "of", numChildren);
      var top:Sprite = box(0xff00ff, 130, 0, 10, 100);
      addChild(top);
      getChildByName("mC").visible = false;
      removeChild(getChildByName("mD"));
      addChild(box(0x8000ff, 440, 0, 20, 100));
      var s:Sprite = new Sprite();
      for each (var r:Array in [[0.5, 1.5, 2.7, 3.4], [-1.5, -0.5, 1, 1], [3.5, 4.5, 0.5, 0.5], [0.25, 0.75, 10.5, 10.5]]) {
        s.scrollRect = new Rectangle(r[0], r[1], r[2], r[3]);
        trace("scrollRect", r, "->", s.scrollRect);
      }

      // Hit tests wait for a frame: before its first render adl answers them as though the stage were scaled.
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        var rA:DisplayObject = getChildByName("rA");
        trace("rA hits", rA.hitTestPoint(5, 5, true), rA.hitTestPoint(50, 40, true), rA.hitTestPoint(5, 5, false));
        var rC:DisplayObject = getChildByName("rC");
        trace("rC hits, the hidden mask's", rC.hitTestPoint(230, 45, true), rC.hitTestPoint(250, 45, true));
        trace("magenta under E's mask", getChildAt(numChildren - 2).hitTestPoint(135, 50, true));
      });
    }
  }
}
