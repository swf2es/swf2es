package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Rectangle;

  // 2D masks from outside still 3D cards, changing from frame to frame:
  // the bitmap each card is drawn into is clipped by the mask as it is
  // now, though the card itself does not change. A band that slides, a
  // mask sprite whose child moves, a mask drawn again bigger, a mask in a
  // 3D parent over its 3D child, and cards with a scrollRect or
  // cacheAsBitmap as well.
  public class ThreeDMaskMoving extends Sprite {
    private var frame:int = 0;
    private var band:Shape;
    private var inner:Shape;
    private var redrawn:Shape;
    private var nested:Shape;

    public function ThreeDMaskMoving() {
      var a:Sprite = card(80, 100);
      a.rotationY = 40;
      band = rect(this, 40, 40, 30, 120);
      a.mask = band;

      var b:Sprite = card(200, 100);
      b.rotationY = -40;
      var holder:Sprite = new Sprite();
      addChild(holder);
      inner = rect(holder, 160, 40, 30, 120);
      b.mask = holder;

      var c:Sprite = card(320, 100);
      c.rotationX = 40;
      redrawn = new Shape();
      addChild(redrawn);
      c.mask = redrawn;

      var g:Sprite = card(440, 100);
      g.rotationY = 30;
      var gc:Sprite = card(0, 0, g, 0x3366cc, 0.5);
      gc.rotationX = 30;
      nested = rect(g, -30, -40, 20, 80);
      gc.mask = nested;

      var e:Sprite = card(140, 300);
      e.rotationY = 40;
      e.scrollRect = new Rectangle(-30, -50, 60, 100);
      e.mask = rect(this, 120, 260, 60, 30);

      var f:Sprite = card(340, 300);
      f.rotationY = -30;
      f.cacheAsBitmap = true;
      f.mask = rect(this, 300, 270, 80, 30);

      addEventListener(Event.ENTER_FRAME, step);
      step(null);
      trace(a.mask == band, b.mask == holder, gc.mask.parent == g);
    }

    private function step(e:Event):void {
      frame++;
      band.x = frame * 12;
      inner.x = frame * 12;
      redrawn.graphics.clear();
      redrawn.graphics.beginFill(0);
      redrawn.graphics.drawRect(300, 40, 20 + frame * 15, 40 + frame * 10);
      redrawn.graphics.endFill();
      nested.y = frame * 15;
    }

    private function rect(parent:Sprite, x:Number, y:Number, w:Number, h:Number):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(0x000000);
      s.graphics.drawRect(x, y, w, h);
      s.graphics.endFill();
      parent.addChild(s);
      return s;
    }

    private function card(x:Number, y:Number, parent:Sprite = null, color:uint = 0xcc3333, scale:Number = 1):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(color);
      s.graphics.drawRect(-40, -60, 80, 120);
      s.graphics.beginFill(0xffffff);
      s.graphics.drawRect(-30, -50, 24, 24);
      s.graphics.endFill();
      s.x = x;
      s.y = y;
      s.scaleX = s.scaleY = scale;
      (parent || this).addChild(s);
      return s;
    }
  }
}
