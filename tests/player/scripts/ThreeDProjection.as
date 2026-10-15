package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.PerspectiveProjection;
  import flash.geom.Point;

  // Cards drawn through the projection of the container they are in: a
  // field of view of 30 degrees, flatter, and of 90, deeper; a centre off
  // to one side, in the container's own space; and the root's, for one
  // under no other. (A projection set on the root itself Flash Player
  // draws by as the player does, adl otherwise: left out.)
  public class ThreeDProjection extends Sprite {
    public function ThreeDProjection() {
      row(110, 30, null);
      row(290, 90, null);
      row(380, 55, new Point(-150, 40));
      var free:Sprite = card(0x888888);
      free.x = 70;
      free.y = 200;
      free.rotationY = 60;
      addChild(free);
      // Measured on the stage, whose width the focal lengths go by.
      addEventListener(Event.ENTER_FRAME, function measure(e:Event):void {
        removeEventListener(Event.ENTER_FRAME, measure);
        for (var i:int = 0; i < numChildren - 1; i++) {
          var pp:PerspectiveProjection = getChildAt(i).transform.perspectiveProjection;
          trace(pp.fieldOfView, pp.focalLength, pp.projectionCenter);
        }
      });
    }

    private function row(x:Number, fieldOfView:Number, centre:Point):void {
      var c:Sprite = new Sprite();
      c.x = x;
      c.y = 110;
      var pp:PerspectiveProjection = new PerspectiveProjection();
      pp.fieldOfView = fieldOfView;
      pp.projectionCenter = centre || new Point(0, 0);
      c.transform.perspectiveProjection = pp;
      addChild(c);
      var a:Sprite = card(0x3366cc);
      a.rotationY = 50;
      a.x = -40;
      c.addChild(a);
      var b:Sprite = card(0xcc6633);
      b.rotationX = 50;
      b.x = 40;
      b.y = 150;
      c.addChild(b);
    }

    private function card(color:uint):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(color);
      s.graphics.drawRect(-30, -40, 60, 80);
      s.graphics.beginFill(0xffffff);
      s.graphics.drawRect(-25, -35, 15, 15);
      s.graphics.endFill();
      return s;
    }
  }
}
