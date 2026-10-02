package {
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Matrix;

  // Bitmap fills (cases.ts, bitmapFills): the timeline's shapes fill with
  // the SWF's bitmap in each of the four fill types; these fill with a
  // BitmapData through beginBitmapFill, repeating or not, smoothed or not,
  // scaled and rotated, and one shows the data's change on the next frame.
  public class BitmapFills extends Sprite {
    public function BitmapFills() {
      var bd:BitmapData = new BitmapData(4, 4, true, 0);
      for (var y:int = 0; y < 4; y++) {
        for (var x:int = 0; x < 4; x++) {
          bd.setPixel32(x, y, 0xFF000000 | (x * 80) << 16 | (y * 80) << 8 | (x == 2 && y == 1 ? 0 : 0xC0));
        }
      }
      bd.setPixel32(3, 3, 0x80FFFFFF);

      var combos:Array = [[true, true], [false, true], [true, false], [false, false]];
      for (var i:int = 0; i < combos.length; i++) {
        var s:Shape = new Shape();
        var m:Matrix = new Matrix();
        m.scale(5, 5);
        m.translate(10, 10);
        s.graphics.beginBitmapFill(bd, m, combos[i][0], combos[i][1]);
        s.graphics.drawRect(0, 0, 45, 40);
        s.graphics.endFill();
        s.x = 5 + i * 50;
        s.y = 55;
        addChild(s);
      }

      var turned:Shape = new Shape();
      var r:Matrix = new Matrix();
      r.scale(4, 4);
      r.rotate(Math.PI / 6);
      turned.graphics.beginBitmapFill(bd, r, true, true);
      turned.graphics.drawRect(0, 0, 45, 40);
      turned.x = 55;
      turned.y = 105;
      addChild(turned);

      // No matrix: the bitmap's own pixels from the shape's origin, repeating by default.
      var plain:Shape = new Shape();
      plain.graphics.beginBitmapFill(bd);
      plain.graphics.drawRect(0, 0, 10, 10);
      plain.x = 110;
      plain.y = 105;
      addChild(plain);

      var live:BitmapData = new BitmapData(2, 2, false, 0x3366CC);
      var shown:Shape = new Shape();
      var big:Matrix = new Matrix();
      big.scale(10, 10);
      shown.graphics.beginBitmapFill(live, big, false, false);
      shown.graphics.drawRect(0, 0, 20, 20);
      shown.x = 130;
      shown.y = 105;
      addChild(shown);
      trace("bounds", shown.getBounds(this), turned.width, turned.height);

      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        removeEventListener(Event.ENTER_FRAME, arguments.callee);
        live.setPixel(1, 1, 0xFFCC00);
        trace("frame 2", live.getPixel(1, 1).toString(16));
      });
    }
  }
}
