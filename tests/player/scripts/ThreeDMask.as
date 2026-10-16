package {
  import flash.display.Shape;
  import flash.display.Sprite;

  // 2D masks on 3D cards. A mask in the card clips it in its own space. One
  // outside it clips the bitmap Flash draws the card into, placed as if the
  // bitmap's corner were where the card's bounds' corner is on the stage:
  // so a band over a turned card leaves a part of the card that is not under
  // it. A 3D mask on a 3D card leaves none of it drawn.
  public class ThreeDMask extends Sprite {
    public function ThreeDMask() {
      // A band on the stage over a card turned about y.
      var a:Sprite = card(80, 100);
      a.rotationY = 50;
      a.mask = band(this, 60, 30, 30, 150);
      // A mask inside the card.
      var b:Sprite = card(200, 100);
      b.rotationY = 50;
      var inner:Shape = band(b, -40, -20, 40, 40);
      b.mask = inner;
      // A card pushed back, a square on the stage over it.
      var c:Sprite = card(320, 100);
      c.z = 200;
      c.mask = band(this, 300, 80, 40, 40);
      // A card turned about x, under a scaled 2D parent, a band on the stage.
      var p:Sprite = new Sprite();
      p.x = 440;
      p.y = 100;
      p.scaleX = p.scaleY = 0.8;
      addChild(p);
      var d:Sprite = card(0, 0, p);
      d.rotationX = 50;
      d.mask = band(this, 400, 90, 80, 20);
      // A turned card whose mask is turned too: a 3D mask masks nothing.
      var e:Sprite = card(80, 300);
      e.rotationY = 50;
      var m3:Shape = band(this, 60, 260, 30, 80);
      m3.rotationY = 20;
      e.mask = m3;
      // The band moved off the card's middle: a card turned about y and offset.
      var f:Sprite = card(200, 300);
      f.rotationY = -60;
      f.rotationX = 20;
      f.mask = band(this, 150, 250, 60, 40);
      // A mask under a 3D parent, on a 3D child.
      var g:Sprite = card(320, 300);
      g.rotationY = 40;
      var gc:Sprite = card(0, 0, g, 0x3366cc, 0.5);
      gc.rotationX = 30;
      gc.mask = band(g, -10, -40, 20, 80);
      // A card off its origin, nearer the eye and so magnified, under a rotated mask.
      var q:Sprite = new Sprite();
      q.x = 440;
      q.y = 300;
      q.rotation = 30;
      addChild(q);
      var h:Sprite = new Sprite();
      h.graphics.beginFill(0x3366cc);
      h.graphics.drawRect(10, 5, 40, 60);
      h.graphics.endFill();
      h.x = 400;
      h.y = 250;
      h.z = -60;
      addChild(h);
      h.mask = band(q, -20, -20, 40, 40);
      trace(a.mask is Shape, b.mask.parent == b, e.mask.z, h.mask.parent == q);
    }

    private function band(parent:Sprite, x:Number, y:Number, w:Number, h:Number):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(0x000000);
      s.graphics.drawRect(x, y, w, h);
      s.graphics.endFill();
      parent.addChild(s);
      return s;
    }

    private function card(x:Number, y:Number, parent:Sprite = null, color:uint = 0xcc3333, scale:Number = 1):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(color);
      s.graphics.drawRect(-40, -60, 80, 120);
      s.graphics.beginFill(0xffffff);
      s.graphics.drawRect(-30, -50, 24, 24);
      s.graphics.endFill();
      s.graphics.lineStyle(2, 0x222222);
      s.graphics.moveTo(-40, 0);
      s.graphics.lineTo(40, 0);
      s.x = x;
      s.y = y;
      s.scaleX = s.scaleY = scale;
      (parent || this).addChild(s);
      return s;
    }
  }
}
