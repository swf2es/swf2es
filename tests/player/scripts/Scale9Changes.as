package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.*;

  // 9-slice scaling as what a grid divides changes (cases.ts,
  // `scale9-changes`): panels scaled 1.5 whose drawing, children or grid
  // change on frame 2, Shape children moved and scaled, a Shape's own
  // grid, a turned parent, BitmapData.draw, a mask, a scrollRect, and hit
  // tests on a curve that crosses the grid; on frame 2 Shapes move between
  // sliced and plain sprites; masks inside a sliced panel, a script's and
  // the timeline's (`clipped`, cases.ts), are drawn unsliced.
  public dynamic class Scale9Changes extends MovieClip {
    private var frame:int = 1;
    private var s:Array = [];
    private var curve:Sprite;
    private var moving:Array = [];

    public function Scale9Changes() {
      // 1: the panel's drawing redrawn wider on frame 2.
      s[1] = slot(1, panel(0x6699cc));
      // 2: a sprite added on frame 2 at 110 to 120 widens what the grid divides.
      s[2] = slot(2, withBars(panel(0x99cc66)));
      // 3: the Shape child moved on frame 2; the edges stay the panel's.
      s[3] = slot(3, withBars(panel(0xcc9966)));
      // 4: the Shape child redrawn wider on frame 2.
      s[4] = slot(4, withBars(panel(0xcc66cc)));
      // 5: the grid changed on frame 2.
      s[5] = slot(5, withBars(panel(0x66cccc)));
      // 6: a child that widened the bounds removed on frame 2.
      var p6:Sprite = withBars(panel(0xcccc66));
      p6.addChild(block("wide", 110, 0, 10, 10, 0x000000));
      s[6] = slot(6, p6);
      // 7: a nested sprite's drawing grows on frame 2; its own child does not count.
      var p7:Sprite = withBars(panel(0x999999));
      var kid:Sprite = block("kid", 80, 2, 10, 10, 0x33aa33);
      kid.addChild(block("deep", 150, 2, 10, 10, 0x000000));
      p7.addChild(kid);
      s[7] = slot(7, p7);
      // 8: under a turned and scaled parent.
      var holder:Sprite = new Sprite();
      holder.rotation = 20;
      holder.scaleY = 0.8;
      holder.x = 440;
      holder.y = 170;
      var p8:Sprite = withBars(panel(0xff9999));
      p8.scale9Grid = new Rectangle(20, 20, 60, 20);
      p8.scaleX = 1.5;
      holder.addChild(p8);
      addChild(holder);
      // 9: a Shape with its own grid.
      var own:Shape = new Shape();
      own.graphics.beginFill(0x9999ff);
      own.graphics.drawRoundRect(0, 0, 100, 60, 32);
      own.graphics.beginFill(0xcc3333);
      own.graphics.drawRect(4, 22, 8, 16);
      own.scale9Grid = new Rectangle(20, 20, 60, 20);
      own.scaleX = 1.5;
      own.x = 215;
      own.y = 170;
      addChild(own);
      // 10: a Shape child with lines, scaled 2: its own scale widens them, the panel's does not.
      var p10:Sprite = panel(0xffcc99);
      var ln:Shape = new Shape();
      ln.graphics.lineStyle(2, 0xff0000);
      ln.graphics.moveTo(3, 11);
      ln.graphics.lineTo(3, 19);
      ln.graphics.moveTo(46, 11);
      ln.graphics.lineTo(46, 19);
      ln.scaleX = 2;
      ln.scaleY = 2;
      p10.addChild(ln);
      s[10] = slot(10, p10);
      // 11: BitmapData.draw of a grid sprite through a scale: not sliced.
      var p11:Sprite = withBars(panel(0x99ffcc));
      p11.scale9Grid = new Rectangle(20, 20, 60, 20);
      var bd:BitmapData = new BitmapData(180, 70, true, 0);
      bd.draw(p11, new Matrix(1.5, 0, 0, 1, 2, 2));
      addChild(at(new Bitmap(bd), 420, 250));
      // 12: BitmapData.draw of a container holding a scaled grid sprite: sliced.
      var p12:Sprite = withBars(panel(0xccff99));
      p12.scale9Grid = new Rectangle(20, 20, 60, 20);
      p12.scaleX = 1.5;
      p12.x = 2;
      p12.y = 2;
      var box:Sprite = new Sprite();
      box.addChild(p12);
      var bd2:BitmapData = new BitmapData(180, 70, true, 0);
      bd2.draw(box);
      addChild(at(new Bitmap(bd2), 10, 330));
      // 17: BitmapData.draw of a grid sprite scaled itself: the draw leaves its scale, and slices nothing.
      var p17:Sprite = withBars(panel(0xffff99));
      p17.scale9Grid = new Rectangle(20, 20, 60, 20);
      p17.scaleX = 1.5;
      var bd3:BitmapData = new BitmapData(180, 70, true, 0);
      bd3.draw(p17, new Matrix(1.5, 0, 0, 1, 2, 2));
      addChild(at(new Bitmap(bd3), 215, 250));
      // 13: a quadratic across the grid line, for the hit tests.
      curve = new Sprite();
      curve.graphics.beginFill(0x444444);
      curve.graphics.moveTo(0, 30);
      curve.graphics.curveTo(0, 0, 40, 0);
      curve.graphics.lineTo(100, 0);
      curve.graphics.lineTo(100, 60);
      curve.graphics.lineTo(0, 60);
      curve.graphics.lineTo(0, 30);
      curve.scale9Grid = new Rectangle(20, 20, 60, 20);
      curve.scaleX = 2;
      curve.x = 215;
      curve.y = 330;
      addChild(curve);
      // 14: the Shape child moved 30 to the right from the start.
      var p14:Sprite = withBars(panel(0xbbbb00));
      p14.getChildByName("bars").x = 30;
      p14.scale9Grid = new Rectangle(20, 20, 60, 20);
      p14.scaleX = 1.5;
      p14.x = 10;
      p14.y = 410;
      addChild(p14);
      // 15: a mask with a grid over a green rectangle: the mask is not sliced.
      var green:Sprite = block("green", 0, 0, 180, 60, 0x33aa33);
      green.x = 440;
      green.y = 330;
      addChild(green);
      var mask:Sprite = new Sprite();
      mask.graphics.beginFill(0);
      mask.graphics.drawRect(0, 0, 1, 1);
      mask.graphics.drawRect(99, 59, 1, 1);
      mask.graphics.drawRect(8, 20, 4, 20);
      mask.graphics.drawRect(88, 20, 4, 20);
      mask.scale9Grid = new Rectangle(20, 20, 60, 20);
      mask.scaleX = 1.8;
      mask.x = 440;
      mask.y = 330;
      addChild(mask);
      green.mask = mask;
      // 16: a scrollRect over a grid: sliced in the drawing's space, then scrolled.
      var p16:Sprite = withBars(panel(0x66ccff));
      p16.scrollRect = new Rectangle(-10, 0, 120, 60);
      p16.scale9Grid = new Rectangle(20, 20, 60, 20);
      p16.scaleX = 1.5;
      p16.x = 215;
      p16.y = 410;
      addChild(p16);

      // 18 to 20: Shapes that move on frame 2, sliced to plain, plain to
      // sliced, and between two grids.
      moving.push(movable(0, true, false, 20));
      moving.push(movable(1, false, true, 20));
      moving.push(movable(2, true, true, 40));
      // 21: a Shape of a sliced panel masking a sprite beside it: the mask is drawn unsliced.
      var p21:Sprite = panel(0xdddddd);
      var masked:Sprite = block("masked", 0, 0, 100, 60, 0x33aa33);
      p21.addChild(masked);
      var bars21:Sprite = withBars(new Sprite());
      var maskShape:Shape = Shape(bars21.removeChildAt(0));
      p21.addChild(maskShape);
      masked.mask = maskShape;
      p21.scale9Grid = new Rectangle(20, 20, 60, 20);
      p21.scaleX = 1.5;
      p21.x = 10;
      p21.y = 490;
      addChild(p21);

      // What the setter checks the grid against: the children's drawings in their own spaces.
      check("moved half", pair(50, 0), new Rectangle(20, 20, 60, 20));
      check("moved back", pair(-40, 50), new Rectangle(20, 20, 60, 20));
      check("child alone", pair(300, -1), new Rectangle(20, 20, 60, 20));
      addEventListener(Event.ENTER_FRAME, step);
    }

    /**
     * A pair of panels scaled 1.5, pair `i` of three along the bottom, with
     * or without a grid, the second's of left edge `left`; the first holds
     * bars that move to the second on frame 2.
     */
    private function movable(i:int, from:Boolean, to:Boolean, left:Number):Array {
      var at:Array = [[170, 490], [330, 490], [490, 490], [10, 570], [170, 570], [330, 570]];
      var pair:Array = [];
      for (var k:int = 0; k < 2; k++) {
        var p:Sprite = panel(k == 0 ? 0xeeddcc : 0xccddee);
        if (k == 0 ? from : to) {
          p.scale9Grid = k == 0 ? new Rectangle(20, 20, 60, 20) : new Rectangle(left, 20, 80 - left, 20);
        }

        p.scaleX = 1.5;
        p.x = at[i * 2 + k][0];
        p.y = at[i * 2 + k][1];
        addChild(p);
        pair.push(p);
      }

      pair[0].addChild(withBars(new Sprite()).removeChildAt(0));
      return pair;
    }

    private function slot(i:int, p:Sprite):Sprite {
      var col:int = (i - 1) % 3;
      var row:int = int((i - 1) / 3);
      p.scale9Grid = new Rectangle(20, 20, 60, 20);
      p.scaleX = 1.5;
      p.x = 10 + col * 205;
      p.y = 10 + row * 80;
      addChild(p);
      return p;
    }

    private function panel(color:uint):Sprite {
      var p:Sprite = new Sprite();
      p.graphics.beginFill(color);
      p.graphics.drawRoundRect(0, 0, 100, 60, 32);
      p.graphics.endFill();
      return p;
    }

    private function withBars(p:Sprite):Sprite {
      var sh:Shape = new Shape();
      sh.graphics.beginFill(0xcc3333);
      sh.graphics.drawRect(4, 22, 8, 16);
      sh.graphics.drawRect(88, 22, 8, 16);
      sh.name = "bars";
      p.addChild(sh);
      return p;
    }

    private function block(n:String, x:Number, y:Number, w:Number, h:Number, color:uint):Sprite {
      var b:Sprite = new Sprite();
      b.graphics.beginFill(color);
      b.graphics.drawRect(x, y, w, h);
      b.name = n;
      return b;
    }

    private function at(o:DisplayObject, x:Number, y:Number):DisplayObject {
      o.x = x;
      o.y = y;
      return o;
    }

    /** A sprite drawing 0 to 50, with a child drawing at `from` to `from` + 50 placed `dx` along; `from` -1 for an empty sprite. */
    private function pair(dx:Number, from:Number):Sprite {
      var p:Sprite = new Sprite();
      if (from >= 0) {
        p.graphics.beginFill(0);
        p.graphics.drawRect(0, 0, 50, 60);
      }

      var c:Sprite = block("c", from < 0 ? 0 : from, 0, from < 0 ? 100 : 50, 60, 0);
      c.x = dx;
      p.addChild(c);
      return p;
    }

    private function check(label:String, o:DisplayObject, r:Rectangle):void {
      try {
        o.scale9Grid = r;
        trace(label, "kept", o.scale9Grid);
      } catch (e:Error) {
        trace(label, "refused", e.errorID);
      }
    }

    private function step(e:Event):void {
      frame++;
      if (frame != 2) {
        return;
      }

      // Where the slice draws the curve, 4 down: from about 28 on; were it flattened and then moved, from 15.
      trace("curve", curve.hitTestPoint(215 + 22, 334, true), curve.hitTestPoint(215 + 40, 334, true));
      var g:Graphics = s[1].graphics;
      g.clear();
      g.beginFill(0x6699cc);
      g.drawRoundRect(0, 0, 120, 60, 32);
      g.endFill();
      s[2].addChild(block("added", 110, 0, 10, 10, 0x000000));
      Shape(s[3].getChildByName("bars")).x = 30;
      var bg:Graphics = Shape(s[4].getChildByName("bars")).graphics;
      bg.clear();
      bg.beginFill(0xcc3333);
      bg.drawRect(4, 22, 16, 16);
      bg.drawRect(88, 22, 30, 16);
      s[5].scale9Grid = new Rectangle(40, 20, 20, 20);
      s[6].removeChild(s[6].getChildByName("wide"));
      var kg:Graphics = Sprite(s[7].getChildByName("kid")).graphics;
      kg.clear();
      kg.beginFill(0x33aa33);
      kg.drawRect(80, 2, 50, 10);
      for each (var pair:Array in moving) {
        pair[1].addChild(pair[0].removeChildAt(0));
      }
    }
  }
}
