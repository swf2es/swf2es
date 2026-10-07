package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.Rectangle;

  // 9-slice scaling (cases.ts, `scale9`): the timeline's panels with
  // DefineScalingGrid, and grids a script sets on what it draws.
  public dynamic class Scale9 extends MovieClip {
    private var frame:int = 1;
    private var drawn:Sprite;
    private var cleared:Sprite;
    private var marks:Sprite;

    public function Scale9() {
      for each (var n:String in ["wide", "small", "turned", "button", "flipped", "edge"]) {
        var o:DisplayObject = getChildByName(n);
        trace(n, o.scale9Grid);
      }

      // A rounded panel, with a Shape child and a Sprite child:
      // the Shape is sliced, the Sprite scaled.
      drawn = panel(0x6699cc);
      var shape:Shape = new Shape();
      shape.graphics.beginFill(0xcc3333);
      shape.graphics.drawRect(4, 22, 8, 16);
      shape.graphics.drawRect(88, 22, 8, 16);
      drawn.addChild(shape);
      var kid:Sprite = new Sprite();
      kid.graphics.beginFill(0x33aa33);
      kid.graphics.drawRect(84, 4, 10, 10);
      drawn.addChild(kid);
      drawn.scale9Grid = new Rectangle(20.7, 20, 60.5, 20);
      trace("drawn", drawn.scale9Grid);
      drawn.x = 10;
      drawn.y = 260;
      drawn.scaleX = 2.5;
      drawn.scaleY = 1.2;
      addChild(drawn);
      trace("drawn bounds", drawn.getBounds(this), drawn.width, drawn.height);

      // Set, then taken away: drawn as ever.
      cleared = panel(0xcc9966);
      cleared.scale9Grid = new Rectangle(20, 20, 60, 20);
      cleared.scale9Grid = null;
      trace("cleared", cleared.scale9Grid);
      cleared.x = 270;
      cleared.y = 260;
      cleared.scaleX = 1.8;
      cleared.scaleY = 1.2;
      addChild(cleared);

      // Grids Flash refuses, and keeps: one on an edge, one past it, an empty sprite's.
      refuse(panel(0), new Rectangle(0, 20, 60, 20));
      refuse(panel(0), new Rectangle(20, 20, 90, 20));
      refuse(new Sprite(), new Rectangle(1, 1, 2, 2));
      refuse(panel(0), new Rectangle(20, 20, 0, 20));

      // Small marks for the hit tests, without a background.
      marks = new Sprite();
      marks.graphics.beginFill(0x000000);
      marks.graphics.drawRect(0, 0, 1, 1);
      marks.graphics.drawRect(99, 59, 1, 1);
      marks.graphics.drawRect(8, 20, 4, 20);
      marks.graphics.drawRect(88, 20, 4, 20);
      marks.scale9Grid = new Rectangle(20, 20, 60, 20);
      marks.x = 10;
      marks.y = 350;
      marks.scaleX = 3;
      addChild(marks);

      addEventListener(Event.ENTER_FRAME, step);
    }

    private function panel(color:uint):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(color);
      s.graphics.drawRoundRect(0, 0, 100, 60, 32);
      s.graphics.endFill();
      return s;
    }

    private function refuse(o:DisplayObject, r:Rectangle):void {
      try {
        o.scale9Grid = r;
        trace("kept", r);
      } catch (e:Error) {
        trace("refused", r, e.errorID, "now", o.scale9Grid);
      }
    }

    private function step(e:Event):void {
      frame++;
      if (frame == 2) {
        var hits:Array = [];
        for (var x:int = 10; x < 320; x += 2) {
          if (marks.hitTestPoint(x, 380, true)) {
            hits.push(x);
          }
        }

        trace("hits", hits);
        // Rescaled: the corners stay as they are.
        drawn.scaleX = 1.5;
        drawn.scaleY = 0.5;
        getChildByName("wide").scaleX = 2;
      }

      if (frame == 3) {
        removeEventListener(Event.ENTER_FRAME, step);
      }
    }
  }
}
