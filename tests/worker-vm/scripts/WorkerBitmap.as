package {
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.external.ExternalInterface;
  import flash.geom.ColorTransform;
  import flash.geom.Matrix;
  import flash.geom.Rectangle;

  public class WorkerBitmap extends Sprite {
    public function WorkerBitmap() {
      ExternalInterface.addCallback("bitmap", bitmap);
      ExternalInterface.call("bitmapReport", bitmap(0, 1));
    }

    private function box(color:uint, w:int, h:int):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(color);
      s.graphics.drawRect(0, 0, w, h);
      s.graphics.endFill();
      return s;
    }

    private function bitmap(seed:int, repeats:int):String {
      var reads:Array = [];
      var d:BitmapData;
      for (var repeat:int = 0; repeat < repeats; repeat++) {
        var s:Sprite = new Sprite();
        var back:Shape = box(0x336699, 32, 24);
        var front:Shape = box(0xff3300, 16, 12);
        front.x = 4;
        front.y = 6;
        s.addChild(back);
        s.addChild(front);
        s.x = 100;
        s.y = 50;
        d = new BitmapData(40, 32, true, 0);
        d.draw(s);
        reads.push(d.getPixel32(2, 2).toString(16));
        reads.push(d.getPixel32(10, 10).toString(16));
        front.graphics.clear();
        front.graphics.beginFill(seed % 2 == 0 ? 0x33cc66 : 0xcc66ff);
        front.graphics.drawRect(0, 0, 16, 12);
        front.graphics.endFill();
        d.draw(s);
        reads.push(d.getPixel32(10, 10).toString(16));
        s.swapChildren(front, back);
        d.draw(s);
        reads.push(d.getPixel32(10, 10).toString(16));
        s.removeChild(back);
        d.fillRect(d.rect, 0);
        d.draw(s);
        reads.push(d.getPixel32(2, 2).toString(16));
        reads.push(d.getPixel32(10, 10).toString(16));
        s.addChildAt(back, 0);
        d.fillRect(d.rect, 0);
        d.draw(s, new Matrix(-1, 0, 0, 1, 32, 0));
        reads.push(d.getPixel32(21, 10).toString(16));
        d.draw(s, new Matrix(1, 0, 0, 1, 4, 4),
          new ColorTransform(1, 0.5, 1, 0.5), "normal", new Rectangle(4, 4, 32, 24));
        reads.push(d.getPixel32(14, 14).toString(16));
        d.draw(s, new Matrix(1, 0, 0, 1, 4, 4), null, "multiply");
        reads.push(d.getPixel32(14, 14).toString(16));
      }
      var pixels:Array = [];
      for (var y:int = 0; y < 32; y++) {
        for (var x:int = 0; x < 40; x++) {
          pixels.push(d.getPixel32(x, y).toString(16));
        }
      }
      return reads.join(",") + "|" + pixels.join(",");
    }
  }
}
