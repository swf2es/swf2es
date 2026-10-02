package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.*;

  public class Masks extends Sprite {
    private var frames:int = 0;
    private var a:Sprite, s:Sprite, p:Sprite, m:Shape, a2:Sprite, a3:Sprite, m2:Shape, hc:Sprite, g:Sprite, gm:Bitmap;

    private function rect(color:uint, x:Number, y:Number, w:Number, h:Number):Sprite {
      var r:Sprite = new Sprite();
      r.graphics.beginFill(color);
      r.graphics.drawRect(x, y, w, h);
      return r;
    }

    private function circle(x:Number, y:Number, r:Number, alpha:Number = 1):Shape {
      var c:Shape = new Shape();
      c.graphics.beginFill(0x00ff00, alpha);
      c.graphics.drawCircle(x, y, r);
      return c;
    }

    public function Masks() {
      // (0,0): a sibling mask.
      a = rect(0xff0000, 0, 0, 100, 100);
      m = circle(50, 50, 30);
      addChild(a);
      addChild(m);
      a.mask = m;
      trace("on list: mask.visible", m.visible, "a.mask is m", a.mask == m, "a.width", a.width, "this.width", this.width);
      trace("a bounds", a.getBounds(this), "m bounds", m.getBounds(this));

      // (1,0): a mask in no display list, at x 50, under a parent at x 100.
      p = new Sprite();
      p.x = 100;
      addChild(p);
      var b:Sprite = rect(0xff0000, 0, 0, 100, 100);
      p.addChild(b);
      var off:Shape = circle(0, 0, 30);
      off.x = 50;
      off.y = 50;
      b.mask = off;
      trace("off list: p.width", p.width, "b.getBounds(p)", b.getBounds(p));

      // (2,0): a mask filled with alpha 0.
      var c:Sprite = rect(0xff0000, 200, 0, 100, 100);
      var cm:Shape = circle(250, 50, 30, 0);
      addChild(c);
      addChild(cm);
      c.mask = cm;

      // (3,0): a mask of a line only.
      var d:Sprite = rect(0xff0000, 300, 0, 100, 100);
      var dm:Shape = new Shape();
      dm.graphics.lineStyle(10, 0);
      dm.graphics.drawCircle(350, 50, 30);
      addChild(d);
      addChild(dm);
      d.mask = dm;

      // (0,1): an invisible mask.
      var e:Sprite = rect(0xff0000, 0, 100, 100, 100);
      var em:Shape = circle(50, 150, 30);
      em.visible = false;
      addChild(e);
      addChild(em);
      e.mask = em;

      // (1,1): a sprite of two circles, one scaled, at half alpha.
      var f:Sprite = rect(0xff0000, 100, 100, 100, 100);
      var fm:Sprite = new Sprite();
      fm.addChild(circle(125, 150, 20));
      var big:Shape = circle(0, 0, 10);
      big.x = 175;
      big.y = 150;
      big.scaleX = 2;
      fm.addChild(big);
      fm.alpha = 0.5;
      addChild(f);
      addChild(fm);
      f.mask = fm;

      // (2,1): a scrollRect over four quarters.
      s = new Sprite();
      s.graphics.beginFill(0xff0000); s.graphics.drawRect(0, 0, 50, 50);
      s.graphics.beginFill(0x0000ff); s.graphics.drawRect(50, 0, 50, 50);
      s.graphics.beginFill(0xffff00); s.graphics.drawRect(0, 50, 50, 50);
      s.graphics.beginFill(0x000000); s.graphics.drawRect(50, 50, 50, 50);
      s.x = 200;
      s.y = 100;
      addChild(s);
      s.scrollRect = new Rectangle(25, 25, 50, 40);
      trace("scroll now: width", s.width, s.height, "bounds", s.getBounds(this), s.getBounds(s), "rect", s.getRect(this));

      // (3,1): one mask set on two objects: the first loses it?
      a2 = rect(0xff0000, 300, 100, 50, 100);
      a3 = rect(0x0000ff, 350, 100, 50, 100);
      m2 = circle(350, 150, 30);
      addChild(a2);
      addChild(a3);
      addChild(m2);
      a2.mask = m2;
      a3.mask = m2;
      trace("reassigned: a2.mask", a2.mask, "a3.mask is m2", a3.mask == m2);

      // (0,2): a bitmap mask, its data transparent but for a corner.
      g = rect(0xff0000, 0, 200, 100, 100);
      var bd:BitmapData = new BitmapData(60, 60, true, 0);
      bd.fillRect(new Rectangle(0, 0, 30, 30), 0xff000000);
      gm = new Bitmap(bd);
      gm.x = 20;
      gm.y = 220;
      addChild(g);
      addChild(gm);
      g.mask = gm;

      // (1,2): a scrolled container, its child clipped by a sibling mask
      // wider than the scroll. (Both cached as bitmaps, Flash clips by the
      // mask's alpha, which is still to come.)
      var h:Sprite = new Sprite();
      h.x = 100;
      h.y = 200;
      hc = rect(0xff0000, 0, 0, 100, 100);
      var hm:Shape = circle(50, 50, 45);
      h.addChild(hc);
      h.addChild(hm);
      hc.mask = hm;
      addChild(h);
      h.scrollRect = new Rectangle(10, 10, 80, 80);

      // (2,2): a masked parent with a masked child.
      var q:Sprite = new Sprite();
      var qc:Sprite = rect(0xff0000, 200, 200, 100, 100);
      q.addChild(qc);
      var qcm:Shape = new Shape();
      qcm.graphics.beginFill(0); qcm.graphics.drawRect(200, 200, 60, 100);
      q.addChild(qcm);
      qc.mask = qcm;
      var qm:Shape = new Shape();
      qm.graphics.beginFill(0); qm.graphics.drawRect(230, 230, 70, 40);
      addChild(q);
      addChild(qm);
      q.mask = qm;
      trace("nested: q.width", q.width, "q bounds", q.getBounds(this));

      // (3,2): a mask that is its masked object's own child.
      var r:Sprite = rect(0xff0000, 300, 200, 100, 100);
      var rm:Shape = circle(350, 250, 30);
      r.addChild(rm);
      addChild(r);
      r.mask = rm;
      trace("own child: r.width", r.width);

      addEventListener(Event.ENTER_FRAME, frame);
    }

    // Hit tests wait for a frame: before its first render adl answers them as though the stage were scaled.
    private function frame(e:Event):void {
      frames++;
      trace("frame", frames, "scroll width", s.width, s.height, "bounds", s.getBounds(this), s.getBounds(s), "x", s.x, s.transform.concatenatedMatrix);
      trace("frame", frames, "local (0,0) global", s.localToGlobal(new Point(0, 0)), "a.width", a.width, "mask visible", m.visible);
      trace("frame", frames, "hits in a", a.hitTestPoint(5, 5, false), a.hitTestPoint(5, 5, true), a.hitTestPoint(50, 50, true), "in the off-list mask's", p.getChildAt(0).hitTestPoint(150, 50, true));
      trace("frame", frames, "hits in s", s.hitTestPoint(210, 110, false), s.hitTestPoint(290, 190, false), s.hitTestPoint(210, 110, true));
      trace("frame", frames, "bitmap-masked: opaque", g.hitTestPoint(30, 230, true), "transparent", g.hitTestPoint(70, 270, true), "outside", g.hitTestPoint(90, 290, true), "edge", g.hitTestPoint(80, 250, true), g.hitTestPoint(81, 250, true), "the masks themselves", gm.hitTestPoint(30, 230, true), m.hitTestPoint(50, 50, true));
      trace("frame", frames, "scrolled and masked: hit", hc.hitTestPoint(103, 250, true), hc.hitTestPoint(112, 250, true), hc.hitTestPoint(150, 250, true), hc.hitTestPoint(185, 250, true));
    }
  }
}
