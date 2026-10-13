package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.*;
  import flash.geom.ColorTransform;

  // Filtered objects blended over an opaque stage, which the GPU's own
  // blending draws, and in layers whose ground is clear, which it must not:
  // glows whose alpha falls off, an object of overlapping parts that Flash
  // blends as one, a colour transform, a blend in a blend. Frame 3 takes the
  // filters off one and changes two modes, frame 4 puts them back, and both
  // move one, whose filters then run again each frame.
  public class BlendDirectFiltered extends Sprite {
    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    private function blob(x:Number, y:Number, mode:String, color:uint, alpha:Number):Sprite {
      var s:Sprite = new Sprite();
      rect(s.graphics, color, alpha, 0, 0, 30, 20);
      rect(s.graphics, 0xffffff, 1, 10, 6, 10, 8);
      s.x = x;
      s.y = y;
      s.blendMode = mode;
      s.filters = [new GlowFilter(0x40ff80, 0.9, 8, 8, 2, 1)];
      return s;
    }

    public function BlendDirectFiltered() {
      // A ground of stripes, dark to light.
      for (var i:int = 0; i < 16; i++) {
        var level:uint = i * 17;
        rect(graphics, (level << 16) | ((255 - level) << 8) | 0x60, 1, i * 20, 0, 20, 160);
      }

      // Row 1: each mode the GPU blends, filtered.
      var modes:Array = ["add", "subtract", "multiply", "screen", "lighten"];
      for (var k:int = 0; k < modes.length; k++) {
        addChild(blob(10 + k * 60, 10, modes[k], 0xff8000, 0.6));
      }

      // Row 2: overlapping parts, added as one; a fill added in a colour transform, unfiltered;
      // a drop shadow that leaves the object out; a faint object subtracted.
      var parts:Sprite = new Sprite();
      var a:Shape = new Shape();
      rect(a.graphics, 0xc04020, 0.7, 0, 0, 30, 20);
      var b:Shape = new Shape();
      rect(b.graphics, 0x2040c0, 0.7, 15, 8, 30, 20);
      parts.addChild(a);
      parts.addChild(b);
      parts.x = 10;
      parts.y = 50;
      parts.blendMode = "add";
      parts.filters = [new BlurFilter(4, 4, 1)];
      addChild(parts);

      var tinted:Sprite = new Sprite();
      rect(tinted.graphics, 0x808080, 0.8, 0, 0, 40, 20);
      tinted.x = 80;
      tinted.y = 50;
      tinted.blendMode = "add";
      tinted.transform.colorTransform = new ColorTransform(0.5, 1, 0.25, 0.8, 40, -30, 80, 0);
      addChild(tinted);

      var shadow:Sprite = blob(140, 50, "add", 0xff8000, 0.8);
      shadow.filters = [new DropShadowFilter(6, 45, 0x2080ff, 1, 6, 6, 1.5, 1, false, false, true)];
      addChild(shadow);

      addChild(blob(200, 50, "subtract", 0x80ff40, 0.4));

      // Row 3: in a layer whose ground is partly clear, in a layer added to the stage, and in a
      // filtered parent: each blend reads its layer. Then one that moves, and one whose filters
      // go and come back.
      var layer:Sprite = new Sprite();
      layer.blendMode = "layer";
      rect(layer.graphics, 0x3060a0, 1, 0, 0, 25, 30);
      layer.addChild(blob(10, 5, "add", 0xa03020, 0.8));
      layer.x = 10;
      layer.y = 90;
      addChild(layer);

      var outer:Sprite = new Sprite();
      outer.blendMode = "add";
      outer.addChild(blob(0, 0, "add", 0x206040, 0.8));
      outer.x = 80;
      outer.y = 95;
      addChild(outer);

      var glowing:Sprite = new Sprite();
      glowing.filters = [new GlowFilter(0xff00ff, 0.6, 4, 4, 1, 1)];
      glowing.addChild(blob(0, 0, "add", 0x406080, 0.8));
      glowing.x = 140;
      glowing.y = 95;
      addChild(glowing);

      var mover:Sprite = blob(210, 95, "add", 0xc0a020, 0.8);
      addChild(mover);

      var plain:Sprite = blob(270, 95, "add", 0x2080c0, 0.8);
      addChild(plain);

      var frame:int = 0;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        frame++;
        if (frame == 2) {
          plain.filters = [];
          tinted.blendMode = "screen";
          shadow.blendMode = "normal";
        } else if (frame == 3) {
          plain.filters = [new BlurFilter(2, 2, 1)];
          tinted.blendMode = "add";
          shadow.blendMode = "add";
        }

        if (frame >= 2) {
          mover.x += 7;
          mover.y += 3;
        }
      });
      trace("drawn");
    }
  }
}
