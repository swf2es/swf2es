package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Vector3D;

  // A card turned about y, 30 degrees a frame from 0 to 180: Flash draws it
  // in perspective, its nearer edge taller, from a bitmap of what it draws.
  // Beside it a card turned about x, the other way, and one turned about
  // both, off the stage's centre.
  public class ThreeDFlip extends Sprite {
    private var cards:Array = [];
    private var turns:int = 0;

    public function ThreeDFlip() {
      cards.push(card(120, 100, 0xcc3333));
      cards.push(card(260, 100, 0x3366cc));
      cards.push(card(400, 100, 0x339933));
      turn();
      addEventListener(Event.ENTER_FRAME, function (e:Event):void {
        turns++;
        turn();
        trace(turns, cards[0].local3DToGlobal(new Vector3D(40, -60, 0)), cards[1].local3DToGlobal(new Vector3D(40, 60, 0)),
          cards[2].local3DToGlobal(new Vector3D(-40, -60, 0)));
      });
    }

    private function card(x:Number, y:Number, color:uint):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(color);
      s.graphics.drawRect(-40, -60, 80, 120);
      s.graphics.beginFill(0xffffff);
      s.graphics.drawRect(-30, -50, 24, 24);
      s.graphics.drawCircle(15, 30, 12);
      s.graphics.endFill();
      s.graphics.lineStyle(2, 0x222222);
      s.graphics.moveTo(-40, 0);
      s.graphics.lineTo(40, 0);
      s.x = x;
      s.y = y;
      addChild(s);
      return s;
    }

    private function turn():void {
      var angle:Number = Math.min(turns, 6) * 30;
      cards[0].rotationY = angle;
      cards[1].rotationX = -angle;
      cards[2].rotationY = angle / 2;
      cards[2].rotationX = angle / 3;
    }
  }
}
