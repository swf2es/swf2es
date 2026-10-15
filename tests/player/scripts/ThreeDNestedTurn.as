package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Vector3D;

  // A 3D card inside a 3D card that turns each frame, its plane well inside
  // the outer's: the inner card turns with the outer, though nothing in the
  // outer changes, so the outer's bitmap must be drawn again.
  public class ThreeDNestedTurn extends Sprite {
    private var outer:Sprite;
    private var inner:Sprite;
    private var turns:int = 0;

    public function ThreeDNestedTurn() {
      outer = card(0x3355aa, 160, 160);
      outer.x = 250;
      outer.y = 150;
      outer.rotationY = 10;
      addChild(outer);
      inner = card(0x55aa33, 40, 40);
      inner.rotationX = 40;
      outer.addChild(inner);
      addEventListener(Event.ENTER_FRAME, function (e:Event):void {
        turns++;
        outer.rotationY = 10 + Math.min(turns, 3) * 20;
        trace(turns, inner.local3DToGlobal(new Vector3D(20, 20, 0)));
      });
    }

    private function card(color:uint, w:Number, h:Number):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(color);
      s.graphics.drawRect(-w / 2, -h / 2, w, h);
      s.graphics.beginFill(0xffffff);
      s.graphics.drawRect(-w / 2 + 4, -h / 2 + 4, w / 4, h / 4);
      s.graphics.endFill();
      return s;
    }
  }
}
