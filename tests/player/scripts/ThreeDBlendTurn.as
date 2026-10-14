package {
  import flash.display.BlendMode;
  import flash.display.Sprite;
  import flash.events.Event;

  // 3D cards turning over a background, blended by modes the GPU's blending cannot draw: the
  // blend stays on the drawn card from frame to frame, not only on the frame it was set.
  public class ThreeDBlendTurn extends Sprite {
    private var cards:Array = [];

    public function ThreeDBlendTurn() {
      graphics.beginFill(0x88cc88);
      graphics.drawRect(0, 0, 500, 100);
      graphics.endFill();
      graphics.beginFill(0x4040a0);
      graphics.drawRect(0, 100, 500, 100);
      graphics.endFill();
      var modes:Array = [
        BlendMode.OVERLAY,
        BlendMode.HARDLIGHT,
        BlendMode.DIFFERENCE,
        BlendMode.MULTIPLY,
        BlendMode.LIGHTEN,
      ];
      for (var i:int = 0; i < modes.length; i++) {
        var s:Sprite = new Sprite();
        s.graphics.beginFill(0xcc6633);
        s.graphics.drawRect(-30, -40, 60, 80);
        s.graphics.endFill();
        s.x = 60 + i * 95;
        s.y = 100;
        s.rotationY = 30;
        s.blendMode = modes[i];
        addChild(s);
        cards.push(s);
      }

      trace("blended", cards.length);
      addEventListener(Event.ENTER_FRAME, turn);
    }

    private function turn(e:Event):void {
      for each (var s:Sprite in cards) {
        s.rotationY += 10;
      }
    }
  }
}
