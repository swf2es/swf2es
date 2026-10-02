// BitmapData.draw of display objects, through the renderer: a Shape, a
// Sprite with children and its own transform (ignored), through a matrix,
// a colour transform and a clipRect, into transparent and opaque bitmaps.
// Interior pixels are traced, exactly; edges are left to the frame, where
// the drawn bitmaps are shown magnified and compared within a tolerance.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.geom.ColorTransform;
  import flash.geom.Matrix;
  import flash.geom.Rectangle;

  public class Main extends Sprite {
    private var shown:int = 0;

    public function Main() {
      var square:Shape = new Shape();
      square.graphics.beginFill(0xFF0000);
      square.graphics.drawRect(2, 2, 8, 8);
      square.graphics.beginFill(0x0000FF, 0.5);
      square.graphics.drawRect(6, 6, 8, 8);
      square.x = 100;
      square.rotation = 30;

      var group:Sprite = new Sprite();
      var inner:Shape = new Shape();
      inner.graphics.beginFill(0x00FF00);
      inner.graphics.drawCircle(8, 8, 6);
      inner.x = 4;
      group.addChild(inner);
      var other:Shape = new Shape();
      other.graphics.beginFill(0x000000, 0.25);
      other.graphics.drawRect(0, 0, 16, 4);
      group.addChild(other);
      group.scaleX = 3;

      var a:BitmapData = new BitmapData(16, 16, true, 0);
      a.draw(square);
      trace("shape", px(a, 4, 4), px(a, 12, 12), px(a, 8, 8), px(a, 0, 0), px(a, 15, 3));
      var b:BitmapData = new BitmapData(16, 16, true, 0);
      b.draw(square, new Matrix(0.5, 0, 0, 0.5, 4, 4));
      trace("shape scaled", px(b, 6, 6), px(b, 10, 10), px(b, 1, 1));
      var c:BitmapData = new BitmapData(16, 16, true, 0x80FFFFFF);
      c.draw(square, null, new ColorTransform(1, 1, 1, 0.5, 0, 255, 0, 0));
      trace("shape ct over", px(c, 4, 4), px(c, 12, 12), px(c, 0, 0));
      var d:BitmapData = new BitmapData(16, 16, false, 0x336699);
      d.draw(square, null, null, null, new Rectangle(0, 0, 6, 16));
      trace("shape clip opaque", px(d, 4, 4), px(d, 8, 4), px(d, 4, 12));
      var e:BitmapData = new BitmapData(24, 16, true, 0);
      e.draw(group);
      trace("group", px(e, 12, 8), px(e, 2, 1), px(e, 12, 3), px(e, 22, 12));
      var f:BitmapData = new BitmapData(16, 16, true, 0);
      f.draw(group, new Matrix(0, 1, -1, 0, 16, 0));
      trace("group turned", px(f, 8, 12), px(f, 14, 2));

      for each (var bd:BitmapData in [a, b, c, d, e, f]) {
        var bm:Bitmap = new Bitmap(bd);
        bm.scaleX = bm.scaleY = 4;
        bm.x = 2 + (shown % 4) * 100;
        bm.y = 2 + int(shown / 4) * 70;
        addChild(bm);
        shown++;
      }
    }

    private function px(bd:BitmapData, x:int, y:int):String {
      return bd.getPixel32(x, y).toString(16);
    }
  }
}
