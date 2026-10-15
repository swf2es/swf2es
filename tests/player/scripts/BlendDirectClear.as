package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.*;

  // Blends over a band an erase blend cleared on the stage itself, outside
  // any layer, as adl clears it: over those clear pixels the GPU's multiply
  // and subtract are not Flash's, so the player keeps their blend filter
  // while the band is on the list. Frame 3 takes the band off, so they
  // blend directly from that frame on. (`stage-erase` and a unit test put
  // a band back.)
  public class BlendDirectClear extends Sprite {
    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    private function blob(x:Number, mode:String, color:uint, glow:Boolean):Sprite {
      var s:Sprite = new Sprite();
      rect(s.graphics, color, 0.7, 0, 0, 30, 60);
      s.x = x;
      s.y = 10;
      s.blendMode = mode;
      if (glow) {
        s.filters = [new GlowFilter(0x40ff80, 0.9, 8, 8, 2, 1)];
      }
      return s;
    }

    public function BlendDirectClear() {
      for (var i:int = 0; i < 12; i++) {
        rect(graphics, i % 2 ? 0x806040 : 0x4080a0, 1, i * 20, 0, 20, 80);
      }

      var band:Shape = new Shape();
      rect(band.graphics, 0x000000, 1, 0, 30, 240, 20);
      band.blendMode = "erase";
      addChild(band);

      var modes:Array = ["multiply", "multiply", "subtract", "subtract", "add", "screen"];
      for (var k:int = 0; k < modes.length; k++) {
        addChild(blob(10 + k * 38, modes[k], 0xc06020 + k * 0x101010, k % 2 == 0));
      }

      var frame:int = 0;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        frame++;
        if (frame == 2) {
          removeChild(band);
        }
      });
      trace("drawn");
    }
  }
}
