package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.*;

  // 9-slice hit tests where children widen what the grid divides
  // (cases.ts, `scale9-hits`): panels scaled 2 whose fills a wider child
  // stretches, drawn so but hit only within their own bounds; a Shape
  // child's likewise; and on frame 2 a bitmap child's data replaced
  // wider, a grandchild Shape reparented into its panel and a Shape
  // child's drawing grown, hit-tested on frame 3, once they are drawn.
  public dynamic class Scale9Hits extends MovieClip {
    private var frame:int = 1;
    private var panels:Array = [];
    private var labels:Array = [];
    private var bm:Bitmap;
    private var sh:Shape;
    private var holder:Sprite;
    private var grown:Shape;

    public function Scale9Hits() {
      // 1: a fill a bitmap child stretches to 230, hit to 200.
      var p:Sprite = panel("fill + bitmap", 0, 0x6699cc, true);
      p.addChild(bitmap(130));
      // 2: its own bars, a Shape child reaching 130: the right bar is drawn at 218 and not hit.
      p = panel("bars + shape", 1, 0x999999, false);
      bars(p.graphics, 0x3333cc);
      p.addChild(rect(new Shape(), 120, 50, 10, 8));
      // 3: a Shape child's bars, a sprite child reaching 130: its right bar likewise.
      p = panel("shape bars + sprite", 2, 0x999999, false);
      var s:Shape = new Shape();
      bars(s.graphics, 0xcc3333);
      p.addChild(s);
      p.addChild(rect(new Sprite(), 120, 50, 10, 8));
      // 4: a Shape child 10 to 100: drawn sliced from 10, hit from 20, where it is unsliced.
      p = panel("shape from 10", 3, 0x999999, false);
      s = new Shape();
      s.graphics.beginFill(0x33aa33);
      s.graphics.drawRect(10, 22, 90, 16);
      p.addChild(s);
      // 5: a Shape child 0 to 30 and a bitmap: hit as drawn, to 51.
      p = panel("shape to 30 + bitmap", 4, 0x999999, false);
      s = new Shape();
      s.graphics.beginFill(0x33aa33);
      s.graphics.drawRect(0, 22, 30, 16);
      p.addChild(s);
      p.addChild(bitmap(130));
      // 6: a fill with a line to 110 and a bitmap: the line's bounds count, hit to 220. The line
      // is white and above the fill, as its round caps anti-alias apart from Flash's.
      p = panel("fill + line + bitmap", 5, 0xcc9966, true);
      p.graphics.lineStyle(10, 0xffffff);
      p.graphics.moveTo(100, -6);
      p.graphics.lineTo(105, -6);
      p.addChild(bitmap(130));
      // 7: a bitmap child replaced by a wider one on frame 2.
      p = panel("bitmap replaced", 6, 0x99cc66, true);
      bm = bitmap(50);
      p.addChild(bm);
      // 8: a grandchild Shape reaching 130 reparented into the panel on frame 2.
      p = panel("reparented", 7, 0xcccc66, true);
      holder = p;
      var mid:Sprite = new Sprite();
      p.addChild(mid);
      sh = rect(new Shape(), 60, 50, 70, 8) as Shape;
      mid.addChild(sh);
      // 9: a Shape child's bars, grown to 130 on frame 2.
      p = panel("grown", 8, 0xcc66cc, true);
      grown = new Shape();
      bars(grown.graphics, 0xcc3333);
      p.addChild(grown);

      addEventListener(Event.ENTER_FRAME, step);
    }

    /** Panel `i`, 100 by 60 scaled 2 with a grid: filled, or only its corners' dots. */
    private function panel(label:String, i:int, color:uint, filled:Boolean):Sprite {
      var p:Sprite = new Sprite();
      p.graphics.beginFill(color);
      if (filled) {
        p.graphics.drawRect(0, 0, 100, 60);
      } else {
        p.graphics.drawRect(0, 0, 1, 1);
        p.graphics.drawRect(99, 59, 1, 1);
      }
      p.graphics.endFill();
      p.scale9Grid = new Rectangle(20, 20, 60, 20);
      p.scaleX = 2;
      p.x = 10 + (i % 2) * 280;
      p.y = 10 + int(i / 2) * 70;
      addChild(p);
      panels.push(p);
      labels.push(label);
      return p;
    }

    private function bars(g:Graphics, color:uint):void {
      g.beginFill(color);
      g.drawRect(4, 22, 8, 16);
      g.drawRect(88, 22, 8, 16);
      g.endFill();
    }

    private function rect(o:*, x:Number, y:Number, w:Number, h:Number):DisplayObject {
      o.graphics.beginFill(0x000000);
      o.graphics.drawRect(x, y, w, h);
      return o;
    }

    private function bitmap(width:int):Bitmap {
      var b:Bitmap = new Bitmap(new BitmapData(width, 8, false, 0x000000));
      b.y = 50;
      return b;
    }

    /** Whether `d` is hit along the row `dy` below `at`'s origin, every 4 pixels from 2, away from the edges. */
    private function row(d:DisplayObject, at:DisplayObject, dy:Number):String {
      var r:String = "";
      for (var x:Number = 2; x < 280; x += 4) {
        r += d.hitTestPoint(at.x + x, at.y + dy, true) ? "1" : "0";
      }
      return r;
    }

    private function step(e:Event):void {
      frame++;
      if (frame == 2) {
        for (var i:int = 0; i < 6; i++) {
          trace(labels[i], row(panels[i], panels[i], 30));
        }

        bm.bitmapData = new BitmapData(130, 8, false, 0x000000);
        holder.addChild(sh);
        grown.graphics.beginFill(0xcc3333);
        grown.graphics.drawRect(120, 40, 10, 10);
      } else if (frame == 3) {
        for (var k:int = 6; k < 9; k++) {
          trace(labels[k], row(panels[k], panels[k], 30));
        }
      }
    }
  }
}
