package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.ColorTransform;

  // Filtered objects in filtered objects, as adl draws them: a glow in a
  // glow, three deep; a multiplied shadow in a blur; a glow in a masked
  // holder in a glow; a faded glow in a bevel; two glows side by side in a
  // shadow.
  public class FiltersNested extends Sprite {
    private function box(color:uint, x:Number, y:Number, w:Number, h:Number):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(color);
      s.graphics.drawRect(0, 0, w, h);
      s.graphics.endFill();
      s.x = x;
      s.y = y;
      return s;
    }

    private function cell(k:int):Sprite {
      var x:Number = (k % 3) * 100;
      var y:Number = int(k / 3) * 100;
      graphics.beginFill(0xc0c0c0);
      graphics.drawRect(x, y, 98, 98);
      graphics.endFill();
      var outer:Sprite = new Sprite();
      outer.x = x + 20;
      outer.y = y + 20;
      addChild(outer);
      return outer;
    }

    public function FiltersNested() {
      // A glow in a glow.
      var a:Sprite = cell(0);
      a.addChild(box(0x3366cc, 0, 0, 40, 40));
      var weapon:Sprite = new Sprite();
      weapon.addChild(box(0xcc3333, 0, 0, 30, 8));
      weapon.x = 20;
      weapon.y = 30;
      weapon.filters = [new GlowFilter(0xffff00, 1, 6, 6, 2, 1)];
      a.addChild(weapon);
      a.filters = [new GlowFilter(0x00ffff, 1, 8, 8, 2, 1)];

      // Three deep.
      var b:Sprite = cell(1);
      b.addChild(box(0x339933, 0, 0, 50, 50));
      var b1:Sprite = new Sprite();
      b1.addChild(box(0x993399, 5, 5, 30, 30));
      var b2:Sprite = new Sprite();
      b2.addChild(box(0xffffff, 10, 10, 10, 10));
      b2.filters = [new GlowFilter(0xff0000, 1, 4, 4, 3, 1)];
      b1.addChild(b2);
      b1.filters = [new BlurFilter(2, 2, 1)];
      b.addChild(b1);
      b.filters = [new GlowFilter(0x0000ff, 1, 6, 6, 2, 1)];

      // A multiplied shadow in a blur.
      var c:Sprite = cell(2);
      c.addChild(box(0xffcc66, 0, 0, 56, 56));
      var c1:Sprite = new Sprite();
      c1.addChild(box(0x6699ff, 10, 10, 30, 30));
      c1.blendMode = BlendMode.MULTIPLY;
      c1.filters = [new DropShadowFilter(4, 45, 0x000000, 1, 4, 4, 1, 1)];
      c.addChild(c1);
      c.filters = [new BlurFilter(3, 3, 1)];

      // A glow in a masked holder, in a glow: the glow's output clipped by the holder's mask.
      var d:Sprite = cell(3);
      d.addChild(box(0x996633, 0, 0, 50, 50));
      var holder:Sprite = new Sprite();
      var d1:Sprite = new Sprite();
      d1.addChild(box(0xffffff, 0, 0, 50, 20));
      d1.filters = [new GlowFilter(0xff00ff, 1, 6, 6, 3, 1)];
      holder.addChild(d1);
      var mask:Shape = box(0x000000, 10, -10, 30, 60);
      d.addChild(mask);
      holder.mask = mask;
      d.addChild(holder);
      d.filters = [new GlowFilter(0x00ff00, 1, 6, 6, 2, 1)];

      // A faded glow in a bevel.
      var e:Sprite = cell(4);
      e.addChild(box(0x666699, 0, 0, 56, 56));
      var e1:Sprite = new Sprite();
      e1.addChild(box(0xffff99, 12, 12, 32, 32));
      e1.filters = [new GlowFilter(0xff6600, 1, 8, 8, 3, 1)];
      e1.transform.colorTransform = new ColorTransform(1, 1, 1, 0.5);
      e.addChild(e1);
      e.filters = [new BevelFilter(3, 45, 0xffffff, 1, 0x000000, 1, 3, 3, 1, 1)];

      // Two glows side by side in a shadow.
      var f:Sprite = cell(5);
      for (var i:int = 0; i < 2; i++) {
        var g:Sprite = new Sprite();
        g.addChild(box(i == 0 ? 0xcc0000 : 0x0000cc, 0, 0, 20, 40));
        g.x = i * 30;
        g.filters = [new GlowFilter(i == 0 ? 0x00ffff : 0xffff00, 1, 5, 5, 2, 1)];
        f.addChild(g);
      }
      f.filters = [new DropShadowFilter(5, 45, 0x000000, 0.6, 4, 4, 1, 1)];
      trace("drawn");
    }
  }
}
