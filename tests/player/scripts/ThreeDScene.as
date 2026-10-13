package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.filters.DropShadowFilter;
  import flash.filters.GlowFilter;
  import flash.geom.Vector3D;

  // 3D objects as Flash draws them: in depth, nearer larger and farther
  // smaller toward the stage's centre; one in another, in one 3D space; a
  // 2D child scaled up in a 3D parent, drawn at the parent's resolution;
  // a 3D card with filters, which turn with it; and one behind the eye,
  // which is not drawn. Siblings are drawn in the list's order whatever
  // their depth.
  public class ThreeDScene extends Sprite {
    public function ThreeDScene() {
      var depths:Array = [-120, 0, 150, 500];
      for (var i:int = 0; i < depths.length; i++) {
        var d:Sprite = card(0xcc6633, 50, 50);
        d.x = 60 + i * 70;
        d.y = 70;
        d.z = depths[i];
        addChild(d);
      }

      var outer:Sprite = card(0x3355aa, 120, 120);
      outer.x = 380;
      outer.y = 90;
      outer.rotationY = 35;
      addChild(outer);
      var inner:Sprite = card(0x55aa33, 50, 50);
      inner.x = 20;
      inner.rotationX = 50;
      outer.addChild(inner);

      var holder:Sprite = new Sprite();
      holder.x = 80;
      holder.y = 260;
      holder.rotationY = -40;
      addChild(holder);
      var big:Shape = new Shape();
      big.graphics.beginFill(0x993399);
      big.graphics.drawCircle(0, 0, 6);
      big.graphics.beginFill(0xffffff);
      big.graphics.drawRect(-2, -2, 2, 2);
      big.scaleX = big.scaleY = 8;
      holder.addChild(big);

      var filtered:Sprite = card(0xaa8833, 70, 90);
      filtered.x = 230;
      filtered.y = 270;
      filtered.rotationY = 50;
      filtered.filters = [new DropShadowFilter(8, 45, 0, 0.8, 4, 4), new GlowFilter(0x00ffff, 1, 6, 6)];
      addChild(filtered);

      var near:Sprite = card(0x33aaaa, 80, 80);
      near.x = 380;
      near.y = 270;
      near.z = -100;
      addChild(near);
      var far:Sprite = card(0xaaaa33, 80, 80);
      far.x = 410;
      far.y = 300;
      far.z = 100;
      addChild(far);

      var behind:Sprite = card(0xff0000, 80, 80);
      behind.x = 250;
      behind.y = 200;
      behind.z = -1000;
      addChild(behind);

      // Measured once on the stage: Flash has no stage size for a projection before.
      addEventListener(Event.ENTER_FRAME, function measure(e:Event):void {
        removeEventListener(Event.ENTER_FRAME, measure);
        trace(inner.getBounds(outer.parent), filtered.getBounds(outer.parent));
        trace(inner.local3DToGlobal(new Vector3D(25, 25, 0)), near.local3DToGlobal(new Vector3D(-40, -40, 0)), far.width);
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
