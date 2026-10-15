package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.*;

  // Erase and alpha blends on the stage itself, outside any layer, which
  // clear what they cover of the stage's pixels, as adl clears them. None
  // is on the list in the first frame, so the blends over where they come
  // draw directly then; the second adds an erase band below them and an
  // alpha band, the band moves in the third and fourth, so what the frame
  // before drew there must not show through, and the fifth takes both off.
  public class StageErase extends Sprite {
    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    private function blob(x:Number, mode:String, color:uint, glow:Boolean):Sprite {
      var s:Sprite = new Sprite();
      rect(s.graphics, color, 0.7, 0, 0, 24, 70);
      s.x = x;
      s.y = 5;
      s.blendMode = mode;
      if (glow) {
        s.filters = [new GlowFilter(0x40ff80, 0.9, 6, 6, 2, 1)];
      }
      return s;
    }

    public function StageErase() {
      for (var i:int = 0; i < 12; i++) {
        rect(graphics, i % 2 ? 0x806040 : 0x4080a0, 1, i * 20, 0, 20, 80);
      }

      var modes:Array = ["multiply", "multiply", "subtract", "subtract", "normal"];
      for (var k:int = 0; k < modes.length; k++) {
        addChild(blob(110 + k * 26, modes[k], 0xc06020 + k * 0x101010, k % 2 == 1));
      }

      var band:Shape = new Shape();
      rect(band.graphics, 0x000000, 1, 0, 0, 120, 16);
      rect(band.graphics, 0x000000, 0.5, 0, 16, 120, 8);
      band.blendMode = "erase";
      band.y = 28;

      var faded:Shape = new Shape();
      rect(faded.graphics, 0x000000, 0.5, 0, 0, 60, 14);
      faded.blendMode = "alpha";
      faded.x = 8;
      faded.y = 60;

      var frame:int = 0;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        frame++;
        if (frame == 1) {
          addChildAt(band, 0);
          addChildAt(faded, 0);
        } else if (frame == 2 || frame == 3) {
          band.x += 40;
          faded.x += 30;
        } else if (frame == 4) {
          removeChild(band);
          removeChild(faded);
        }
      });
      trace("drawn");
    }
  }
}
