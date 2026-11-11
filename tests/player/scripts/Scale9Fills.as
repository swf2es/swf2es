// Bitmap fills in 9-slice panels (cases.ts, `scale9-fills`). adl maps a
// fill's bitmap by the fill: from the box around what one beginFill to its
// endFill draws to that box as sliced. So a panel drawn as nine fills, one
// a region, keeps its corners' bitmap their size and stretches its edges'
// one way, the idiom for a skinned panel; one fill of nine rectangles, or
// one over all regions, is stretched whole; a fill inside the centre goes
// as the centre does. A Shape child's fills go by the parent's grid alike.
package {
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.geom.Rectangle;

  public class Scale9Fills extends Sprite {
    private const EDGES:Array = [0, 10, 20, 30];

    /** A rounded panel 30 by 30: a dark ring of corners round a checker, so that stretching shows. */
    private function skin():BitmapData {
      const b:BitmapData = new BitmapData(30, 30, true, 0);
      for (var y:int = 0; y < 30; y++) {
        for (var x:int = 0; x < 30; x++) {
          const dx:Number = Math.max(0, Math.max(9 - x, x - 20));
          const dy:Number = Math.max(0, Math.max(9 - y, y - 20));
          const d:Number = Math.sqrt(dx * dx + dy * dy);
          if (d <= 9.5) {
            b.setPixel32(x, y, d > 6.5 ? 0xff204080 : ((x + y) & 1 ? 0xffffd040 : 0xffe06020));
          }
        }
      }

      return b;
    }

    private function nine(g:*, b:BitmapData, each:Boolean):void {
      if (!each) {
        g.beginBitmapFill(b, null, false, false);
      }

      for (var j:int = 0; j < 3; j++) {
        for (var i:int = 0; i < 3; i++) {
          if (each) {
            g.beginBitmapFill(b, null, false, false);
          }

          g.drawRect(EDGES[i], EDGES[j], 10, 10);
          if (each) {
            g.endFill();
          }
        }
      }

      if (!each) {
        g.endFill();
      }
    }

    private function panel(kind:int):Sprite {
      const s:Sprite = new Sprite();
      const b:BitmapData = skin();
      switch (kind) {
        case 0:
          // Nine fills, one a region.
          nine(s.graphics, b, true);
          break;
        case 1:
          // One fill of nine rectangles.
          nine(s.graphics, b, false);
          break;
        case 2:
          // A fill inside the centre, and one over all regions with a hole.
          s.graphics.beginBitmapFill(b, null, false, false);
          s.graphics.drawRect(12, 12, 6, 6);
          s.graphics.endFill();
          s.graphics.beginBitmapFill(b, null, false, false);
          s.graphics.drawRect(0, 0, 30, 30);
          s.graphics.drawRect(10, 10, 10, 10);
          s.graphics.endFill();
          break;
        case 3:
          // A Shape child's nine fills, under a backing of the panel's own.
          s.graphics.beginFill(0xdddddd);
          s.graphics.drawRect(0, 0, 30, 30);
          s.graphics.endFill();
          const child:Shape = new Shape();
          nine(child.graphics, b, true);
          s.addChild(child);
          break;
      }

      s.scale9Grid = new Rectangle(10, 10, 10, 10);
      return s;
    }

    public function Scale9Fills() {
      graphics.beginFill(0xffffff);
      graphics.drawRect(0, 0, 400, 200);
      graphics.endFill();
      for (var k:int = 0; k < 4; k++) {
        const p:Sprite = panel(k);
        p.x = 5 + (k % 3) * 132;
        p.y = 5 + int(k / 3) * 100;
        p.scaleX = 4;
        p.scaleY = 3;
        addChild(p);
      }

      trace("drawn");
    }
  }
}
