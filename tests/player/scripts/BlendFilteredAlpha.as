package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.*;
  import flash.geom.ColorTransform;

  // Filtered objects as adl composites them: in the top row each blended
  // with an alpha of its own, in the middle row coloured with offsets
  // under a glow, in the bottom row subtracted and otherwise blended
  // inside a filtered parent, over the parent's clear ground as well as
  // over its fill.
  public class BlendFilteredAlpha extends Sprite {
    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    private function blob(x:Number, y:Number, color:uint, alpha:Number):Sprite {
      var s:Sprite = new Sprite();
      rect(s.graphics, color, alpha, 0, 0, 24, 24);
      s.x = x;
      s.y = y;
      return s;
    }

    public function BlendFilteredAlpha() {
      for (var i:int = 0; i < 16; i++) {
        rect(graphics, i % 2 ? 0x806040 : 0x4080a0, 1, i * 20, 0, 20, 200);
      }

      var modes:Array = ["normal", "layer", "multiply", "screen", "add", "subtract", "lighten", "difference", "overlay"];
      for (var k:int = 0; k < modes.length; k++) {
        var a:Sprite = blob(8 + k * 34, 8, 0xc06020 + k * 0x0c1418, 0.8);
        a.blendMode = modes[k];
        a.alpha = 0.6;
        a.filters = [new GlowFilter(0x40ff80, 0.9, 6, 6, 2, 1)];
        addChild(a);
      }

      var offsets:Array = [
        new ColorTransform(1, 1, 1, 1, 80, -40, 20, 0),
        new ColorTransform(0.5, 1, 0.5, 1, 0, 120, 0, 0),
        new ColorTransform(1, 1, 1, 0.5, 0, 0, 0, 60),
        new ColorTransform(1, 1, 1, 1, 0, 0, 0, -80),
        new ColorTransform(1.5, 0.5, 1, 1, -60, 60, 200, 0),
      ];
      for (var m:int = 0; m < offsets.length; m++) {
        var c:Sprite = blob(8 + m * 34, 52, 0x3060c0, 0.8);
        c.filters = [new GlowFilter(0xff4020, 1, 8, 8, 2, 1)];
        c.transform.colorTransform = offsets[m];
        addChild(c);
      }
      var shadowed:Sprite = blob(8 + 5 * 34, 52, 0x3060c0, 0.8);
      shadowed.filters = [new DropShadowFilter(4, 45, 0x000000, 1, 4, 4, 1, 1)];
      shadowed.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 100, 100, 0, 0);
      addChild(shadowed);
      var blended:Sprite = blob(8 + 6 * 34, 52, 0x3060c0, 0.8);
      blended.filters = [new GlowFilter(0xff4020, 1, 8, 8, 2, 1)];
      blended.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 60, 0, -60, 0);
      blended.blendMode = "multiply";
      addChild(blended);

      var inner:Array = ["subtract", "add", "multiply", "screen", "difference", "erase"];
      for (var n:int = 0; n < inner.length; n++) {
        var parent:Sprite = new Sprite();
        rect(parent.graphics, 0x60a040, 1, 0, 0, 16, 36);
        parent.x = 8 + n * 50;
        parent.y = 100;
        parent.filters = [new GlowFilter(0x2040ff, 1, 4, 4, 1, 1)];
        var child:Sprite = blob(6, 6, 0xc08040, 0.9);
        child.blendMode = inner[n];
        parent.addChild(child);
        addChild(parent);
      }

      // Colour from above: an unfiltered parent's alpha and offsets, and a filtered parent's,
      // over glowing children, one of them offset itself. The second frame changes them, and the
      // alpha of the first row's normal object, whose kept output is then drawn in its new colour.
      var fading:Sprite = getChildAt(0) as Sprite;
      var holders:Array = [];
      var tints:Array = [
        new ColorTransform(1, 1, 1, 0.5, 0, 0, 0, 0),
        new ColorTransform(1, 1, 1, 1, 90, 0, -50, 0),
        new ColorTransform(0.6, 1, 1, 0.7, 0, 40, 0, 0),
      ];
      for (var h:int = 0; h < 6; h++) {
        var holder:Sprite = new Sprite();
        holder.x = 8 + h * 52;
        holder.y = 156;
        var glowing:Sprite = blob(0, 0, 0x3060c0, 0.8);
        glowing.filters = [new GlowFilter(0xff4020, 1, 8, 8, 2, 1)];
        if (h % 3 == 2) {
          glowing.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 0, 0, 120, 0);
        }
        holder.addChild(glowing);
        var plain:Sprite = blob(14, 14, 0x40a060, 1);
        holder.addChild(plain);
        if (h >= 3) {
          holder.filters = [new DropShadowFilter(3, 45, 0x000000, 1, 3, 3, 1, 1)];
        }
        holder.transform.colorTransform = tints[h % 3];
        addChild(holder);
        holders.push(holder);
      }

      var frame:int = 0;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        frame++;
        if (frame == 1) {
          fading.alpha = 0.3;
          for (var j:int = 0; j < holders.length; j++) {
            holders[j].transform.colorTransform = tints[(j + 1) % 3];
          }
        }
      });
      trace("drawn");
    }
  }
}
