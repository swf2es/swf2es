package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.*;
  import flash.geom.Rectangle;

  // Filtered objects that stay put a frame, then change: one moved, one
  // whose child is drawn again, one scaled and then turned, one whose
  // filters are set anew; then their parent moved and scaled, and a
  // grandchild moved; and one scrolled a pixel. Flash draws a filtered
  // object again for each. adl does not for a child moved within its
  // parent's bounds, which its capture shows where it was too, nor for a
  // mask from outside that moved, which it shows clipped as it was: both
  // are left out.
  public class FilterCache extends Sprite {
    private var group:Sprite = new Sprite();
    private var moved:Sprite;
    private var redrawn:Sprite;
    private var scaled:Sprite;
    private var refiltered:Sprite;
    private var scrolled:Sprite;
    private var frame:int = 0;

    private function square(color:uint, x:Number, y:Number, size:Number):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(color);
      s.graphics.drawRect(0, 0, size, size);
      s.graphics.endFill();
      s.x = x;
      s.y = y;
      return s;
    }

    private function cell(k:int, filters:Array):Sprite {
      var o:Sprite = new Sprite();
      o.addChild(square(0x00aa00, -12, -12, 24));
      var inner:Sprite = new Sprite();
      inner.addChild(square(0xffcc00, 0, 0, 8));
      o.addChild(inner);
      o.x = 30 + k * 60;
      o.y = 40;
      o.filters = filters;
      group.addChild(o);
      return o;
    }

    public function FilterCache() {
      graphics.beginFill(0x808080);
      graphics.drawRect(0, 0, 380, 100);
      graphics.endFill();
      addChild(group);
      moved = cell(0, [new GlowFilter(0xff0000, 1, 6, 6, 2, 1)]);
      redrawn = cell(1, [new DropShadowFilter(4, 45, 0, 1, 4, 4, 1, 1)]);
      scaled = cell(2, [new BlurFilter(4, 4, 2)]);
      refiltered = cell(3, [new GlowFilter(0xffffff, 1, 8, 8, 2, 3)]);
      // A child of a filtered object masked by a shape outside it.
      var masked:Sprite = cell(4, [new GlowFilter(0xff00ff, 1, 4, 4, 2, 1)]);
      var outside:Shape = square(0xffffff, masked.x - 12, masked.y - 12, 16);
      addChild(outside);
      masked.getChildAt(0).mask = outside;
      // A filtered object scrolled by its scrollRect.
      scrolled = new Sprite();
      for (var i:int = 0; i < 6; i++) {
        scrolled.addChild(square(i % 2 ? 0x0033cc : 0xffcc00, i * 6, 0, 6));
      }
      scrolled.scrollRect = new Rectangle(0, 0, 24, 6);
      scrolled.x = 318;
      scrolled.y = 37;
      scrolled.filters = [new DropShadowFilter(4, 45, 0, 1, 2, 2, 1, 1)];
      addChild(scrolled);
      addEventListener(Event.ENTER_FRAME, tick);
      trace("drawn");
    }

    private function tick(e:Event):void {
      frame++;
      if (frame == 2) {
        moved.x += 7;
        moved.y += 3;
        var child:Shape = redrawn.getChildAt(0) as Shape;
        child.graphics.clear();
        child.graphics.beginFill(0xcc3300);
        child.graphics.drawRect(0, 0, 24, 24);
        child.graphics.endFill();
        scaled.scaleX = 1.5;
        refiltered.filters = [new GlowFilter(0x00ffff, 1, 4, 4, 2, 1)];
      } else if (frame == 3) {
        scaled.rotation = 30;
      } else if (frame == 4) {
        group.x += 5;
      } else if (frame == 5) {
        group.scaleY = 0.75;
        (refiltered.getChildAt(1) as Sprite).getChildAt(0).y = 8;
      } else if (frame == 6) {
        scrolled.scrollRect = new Rectangle(1, 0, 24, 6);
      } else if (frame == 7) {
        removeEventListener(Event.ENTER_FRAME, tick);
        trace("done");
      }
    }
  }
}
