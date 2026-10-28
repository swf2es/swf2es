package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.GlowFilter;
  import flash.geom.ColorTransform;

  // Blends that read what is behind, over a ground, frame after frame: the player keeps such a
  // layer while nothing in it changes but where it is, and blends it with what is behind again on
  // every frame. A stands still; B moves on frames 2 and 4; C is recoloured on frame 3; a part of D
  // moves on frames 2 and 5; what is behind E changes on frames 2, 3 and 5 while E stands; F, a
  // glowing sprite, holds an overlay child, which moves on frame 4; G has a glow of its own and an
  // overlay, and moves on frame 3; H changes its mode on frame 5 and moves on frame 6; I, a single
  // fill, takes an alpha on frame 6 (one fill: adl applies an alpha to a layer of several parts as
  // a whole, which swf2es does not yet do). Opaque grounds and shapes on whole pixels, moved by
  // whole pixels.
  public class BlendKept extends Sprite {
    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    private function part(s:Sprite, color:uint, alpha:Number, x:Number, y:Number):Shape {
      var p:Shape = new Shape();
      rect(p.graphics, color, alpha, x, y, 24, 18);
      s.addChild(p);
      return p;
    }

    private function layer(mode:String, x:Number, y:Number):Sprite {
      var s:Sprite = new Sprite();
      part(s, 0xe08030, 0.8, 0, 0);
      part(s, 0x3070d0, 0.6, 10, 8);
      s.blendMode = mode;
      s.x = x;
      s.y = y;
      addChild(s);
      return s;
    }

    public function BlendKept() {
      for (var i:int = 0; i < 12; i++) {
        rect(graphics, i % 2 ? 0x406080 : 0xa07040, 1, i * 20, 0, 20, 120);
      }
      rect(graphics, 0xd0d0c0, 1, 0, 60, 240, 20);

      var a:Sprite = layer("overlay", 6, 6);
      var b:Sprite = layer("overlay", 50, 6);
      var c:Sprite = layer("overlay", 100, 6);
      var d:Sprite = layer("hardlight", 150, 6);
      var dPart:Shape = Shape(d.getChildAt(1));

      // What is behind E, a sibling below it.
      var behind:Shape = new Shape();
      rect(behind.graphics, 0x20c060, 1, 0, 0, 30, 24);
      behind.x = 196;
      behind.y = 8;
      addChild(behind);
      var e:Sprite = layer("overlay", 200, 6);

      var f:Sprite = new Sprite();
      rect(f.graphics, 0x804020, 1, 0, 0, 40, 30);
      var inner:Sprite = new Sprite();
      part(inner, 0xf0e060, 0.9, 0, 0);
      part(inner, 0x30a0f0, 0.7, 8, 6);
      inner.blendMode = "overlay";
      inner.x = 6;
      inner.y = 4;
      f.addChild(inner);
      f.filters = [new GlowFilter(0xffffff, 1, 6, 6, 2, 1)];
      f.x = 10;
      f.y = 50;
      addChild(f);

      var g:Sprite = layer("overlay", 80, 50);
      g.filters = [new GlowFilter(0x000000, 1, 4, 4, 2, 1)];

      var h:Sprite = layer("lighten", 140, 50);

      var i1:Sprite = new Sprite();
      rect(i1.graphics, 0x60e0a0, 1, 0, 0, 30, 20);
      i1.blendMode = "overlay";
      i1.x = 190;
      i1.y = 54;
      addChild(i1);

      var frame:int = 0;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        frame++;
        if (frame == 1) {
          b.x += 3;
          dPart.x += 4;
          behind.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 120, -60, 0, 0);
        } else if (frame == 2) {
          c.transform.colorTransform = new ColorTransform(0.5, 1, 1, 1, 0, 40, 0, 0);
          behind.x -= 6;
          g.x += 5;
        } else if (frame == 3) {
          b.y += 2;
          inner.x += 7;
        } else if (frame == 4) {
          dPart.y += 5;
          behind.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 0, 0, 160, 0);
          h.blendMode = "difference";
        } else if (frame == 5) {
          h.x += 4;
          i1.alpha = 0.5;
        }
      });
      trace("drawn");
    }
  }
}
