package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.*;
  import flash.geom.ColorTransform;
  import flash.geom.Matrix;
  import flash.text.TextField;

  // Filtered objects' colour where what is in them, or around them, is
  // more than shapes: a child's own colour inside a filtered parent, a mask
  // in one, a text field's and a bitmap's, filtered objects in filtered
  // objects; filters taken off and put on with a colour that stays, on the
  // second frame; filtered objects that are, or are in, branches of many
  // draws (Pixi's render groups) under colours that multiply only; 3D (at
  // a z of 0, as swf2es draws no perspective); BitmapData.draw of
  // coloured objects, which takes them without their own colour; and
  // colours that leave a filtered object clear, or opaque from clear.
  public class FilteredColors extends Sprite {
    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    private function blob(x:Number, y:Number, color:uint, alpha:Number, size:Number = 24):Sprite {
      var s:Sprite = new Sprite();
      rect(s.graphics, color, alpha, 0, 0, size, size);
      s.x = x;
      s.y = y;
      return s;
    }

    private function pair(x:Number, y:Number):Sprite {
      var s:Sprite = new Sprite();
      s.x = x;
      s.y = y;
      s.addChild(blob(0, 0, 0xd04020, 1));
      s.addChild(blob(10, 10, 0x30a050, 1));
      return s;
    }

    private function many(x:Number, y:Number, color:uint):Sprite {
      var s:Sprite = new Sprite();
      s.x = x;
      s.y = y;
      for (var i:int = 0; i < 80; i++) {
        s.addChild(blob((i % 8) * 5, int(i / 8) * 5, color + (i % 5) * 0x101008, 1, 4));
      }
      return s;
    }

    private function glow(color:uint = 0xff4020):Array {
      return [new GlowFilter(color, 1, 6, 6, 2, 1)];
    }

    public function FilteredColors() {
      for (var i:int = 0; i < 16; i++) {
        rect(graphics, i % 2 ? 0x806040 : 0x4080a0, 1, i * 20, 0, 20, 240);
      }

      // A child's own colour inside a coloured, filtered parent.
      var a:Sprite = pair(8, 8);
      (a.getChildAt(0) as Sprite).transform.colorTransform = new ColorTransform(1, 1, 1, 0.5, 0, 0, 100, 0);
      a.filters = glow();
      a.transform.colorTransform = new ColorTransform(0.5, 1, 1, 0.7, 0, 80, 0, 0);
      addChild(a);

      // A child masked by its sibling, in a coloured, filtered parent.
      var b:Sprite = pair(60, 8);
      var m:Shape = new Shape();
      m.graphics.beginFill(0);
      m.graphics.drawCircle(17, 17, 14);
      m.graphics.endFill();
      b.addChild(m);
      (b.getChildAt(1) as Sprite).mask = m;
      b.filters = glow(0x2060ff);
      b.transform.colorTransform = new ColorTransform(1, 1, 1, 0.8, 60, 0, 0, 0);
      addChild(b);

      // A text field's background and border, filtered and coloured.
      var t:TextField = new TextField();
      t.x = 112;
      t.y = 8;
      t.width = 30;
      t.height = 24;
      t.background = true;
      t.backgroundColor = 0x3060c0;
      t.border = true;
      t.borderColor = 0xffff00;
      t.filters = glow();
      t.transform.colorTransform = new ColorTransform(1, 1, 1, 0.6, 0, 0, 80, 0);
      addChild(t);

      // A bitmap, opaque and half clear, filtered and coloured.
      var data:BitmapData = new BitmapData(24, 24, true, 0);
      data.fillRect(new flash.geom.Rectangle(0, 0, 12, 24), 0xffc08040);
      data.fillRect(new flash.geom.Rectangle(12, 0, 12, 24), 0x8040a0c0);
      var bitmap:Bitmap = new Bitmap(data);
      bitmap.x = 164;
      bitmap.y = 8;
      bitmap.filters = glow(0x40ff80);
      bitmap.transform.colorTransform = new ColorTransform(0.5, 1, 1, 0.8, 0, 0, 0, 40);
      addChild(bitmap);

      // Filtered in unfiltered in filtered in unfiltered, each coloured.
      var e:Sprite = new Sprite();
      e.x = 216;
      e.y = 8;
      e.transform.colorTransform = new ColorTransform(1, 1, 1, 0.8, 0, -60, 0, 0);
      var e1:Sprite = pair(0, 0);
      e1.filters = glow();
      e1.transform.colorTransform = new ColorTransform(1, 0.5, 1, 1, 40, 0, 0, 0);
      var e2:Sprite = new Sprite();
      e2.x = 20;
      e2.transform.colorTransform = new ColorTransform(0.3, 1, 1, 1, 0, 0, 0, 0);
      var e3:Sprite = blob(0, 14, 0x3060c0, 0.9);
      e3.filters = glow(0x40ff80);
      e3.transform.colorTransform = new ColorTransform(1, 1, 1, 0.6, 0, 0, 0, 0);
      e2.addChild(e3);
      e1.addChild(e2);
      e.addChild(e1);
      addChild(e);

      // An alpha of 0 and an alpha offset, filtered; and one faded in from 0 on the second frame.
      var z1:Sprite = pair(268, 8);
      z1.filters = glow();
      z1.transform.colorTransform = new ColorTransform(1, 1, 1, 0, 0, 0, 0, 160);
      addChild(z1);
      var z2:Sprite = pair(268, 64);
      z2.filters = glow();
      z2.alpha = 0;
      addChild(z2);
      var z3:Sprite = pair(268, 116);
      z3.filters = glow();
      z3.alpha = 0;
      addChild(z3);

      // Filters taken off or put on, on the second frame.
      var g:Sprite = pair(8, 64);
      g.filters = glow();
      g.alpha = 0.5;
      addChild(g);
      var h:Sprite = pair(60, 64);
      h.alpha = 0.5;
      addChild(h);
      var k:Sprite = pair(112, 64);
      k.filters = glow();
      k.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 0, 100, 0, 0);
      addChild(k);
      var n:Sprite = pair(164, 64);
      n.filters = glow();
      addChild(n);
      var p:Sprite = pair(216, 64);
      p.alpha = 0.5;
      p.filters = glow(0x2060ff);
      addChild(p);

      // Branches of many draws: filtered and coloured; in a filtered, coloured parent; under a
      // parent that multiplies only, with a filtered child, or filtered itself; and in a filtered
      // parent that multiplies only, with a coloured, filtered child.
      var l:Sprite = many(8, 116, 0x406080);
      l.filters = glow();
      l.transform.colorTransform = new ColorTransform(1, 1, 1, 0.6, 40, 0, -40, 0);
      addChild(l);
      var q:Sprite = new Sprite();
      q.x = 60;
      q.y = 116;
      var q1:Sprite = many(0, 0, 0x406080);
      q1.alpha = 0.8;
      q.addChild(q1);
      q.filters = glow();
      q.transform.colorTransform = new ColorTransform(0.5, 1, 1, 0.7, 0, 60, 0, 0);
      addChild(q);
      var r:Sprite = new Sprite();
      r.x = 112;
      r.y = 116;
      var r1:Sprite = many(0, 0, 0x406080);
      var r2:Sprite = pair(6, 6);
      r2.filters = glow();
      r1.addChild(r2);
      r.addChild(r1);
      r.transform.colorTransform = new ColorTransform(0.5, 1, 0.7, 0.6, 0, 0, 0, 0);
      addChild(r);
      var s:Sprite = new Sprite();
      s.x = 164;
      s.y = 116;
      var s1:Sprite = many(0, 0, 0x406080);
      s1.filters = glow();
      s.addChild(s1);
      s.transform.colorTransform = new ColorTransform(0.5, 1, 0.7, 0.6, 0, 0, 0, 0);
      addChild(s);
      var u:Sprite = new Sprite();
      u.x = 216;
      u.y = 116;
      var u1:Sprite = many(0, 0, 0x406080);
      var u2:Sprite = pair(6, 6);
      u2.filters = glow(0x40ff80);
      u2.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 0, 0, 90, 0);
      u1.addChild(u2);
      u.addChild(u1);
      u.filters = glow();
      u.transform.colorTransform = new ColorTransform(0.6, 0.8, 1, 0.7, 0, 0, 0, 0);
      addChild(u);

      // In 3D, filtered and faded.
      var v:Sprite = pair(8, 176);
      v.z = 0;
      v.filters = glow();
      v.alpha = 0.6;
      addChild(v);

      // BitmapData.draw takes its object without its own colour, its filtered child's with it; and
      // a coloured object without filters the same.
      var x1:Sprite = new Sprite();
      // A clear fill around the child: swf2es draws an object's bounds alone, its filters' reach
      // left out.
      rect(x1.graphics, 0, 0, 0, 0, 48, 48);
      x1.transform.colorTransform = new ColorTransform(1, 1, 1, 0.7, 0, 0, 0, 0);
      var x2:Sprite = pair(6, 6);
      x2.filters = glow();
      x2.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 60, 0, 0, 0);
      x1.addChild(x2);
      var drawn:BitmapData = new BitmapData(48, 48, true, 0);
      drawn.draw(x1);
      var shown:Bitmap = new Bitmap(drawn);
      shown.x = 60;
      shown.y = 170;
      addChild(shown);
      var y1:Sprite = pair(0, 0);
      y1.transform.colorTransform = new ColorTransform(1, 1, 1, 0.5, 0, 80, 0, 0);
      var drawn2:BitmapData = new BitmapData(48, 48, true, 0);
      drawn2.draw(y1, new Matrix(1, 0, 0, 1, 6, 6));
      var shown2:Bitmap = new Bitmap(drawn2);
      shown2.x = 112;
      shown2.y = 170;
      addChild(shown2);

      var frame:int = 0;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        frame++;
        if (frame == 1) {
          g.filters = [];
          h.filters = glow();
          k.filters = [];
          n.transform.colorTransform = new ColorTransform(1, 1, 1, 0.4, 0, 0, 0, 0);
          (p.getChildAt(0) as Sprite).filters = glow(0x40ff80);
          r.transform.colorTransform = new ColorTransform(1, 0.5, 1, 0.8, 0, 0, 0, 0);
          s.transform.colorTransform = new ColorTransform(1, 0.5, 1, 0.8, 0, 0, 0, 0);
          u.transform.colorTransform = new ColorTransform(1, 1, 0.5, 0.5, 0, 0, 0, 0);
          z3.alpha = 0.7;
        }
      });
      trace("drawn");
    }
  }
}
