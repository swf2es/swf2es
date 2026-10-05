package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.geom.Point;
  import flash.geom.Rectangle;

  // BitmapData.paletteMap's tables and compare's differences.
  public class PaletteCompare extends Sprite {
    public function PaletteCompare() {
      var source:BitmapData = new BitmapData(4, 1, true, 0);
      source.setPixel32(0, 0, 0xff102030);
      source.setPixel32(1, 0, 0x80405060);
      source.setPixel32(2, 0, 0xffffffff);
      source.setPixel32(3, 0, 0x00000000);

      var red:Array = [];
      var green:Array = [];
      for (var i:int = 0; i < 256; i++) {
        red.push((255 - i) << 16);
        green.push(i << 9);
      }

      var mapped:BitmapData = new BitmapData(4, 1, true, 0xffabcdef);
      mapped.paletteMap(source, source.rect, new Point(0, 0), red, null, null, null);
      dump("red inverted", mapped);
      mapped.paletteMap(source, new Rectangle(1, 0, 2, 1), new Point(2, 0), null, green);
      dump("green doubled, shifted", mapped);
      var opaque:BitmapData = new BitmapData(4, 1, false, 0);
      opaque.paletteMap(source, source.rect, new Point(0, 0));
      dump("into opaque", opaque);
      try {
        mapped.paletteMap(null, source.rect, new Point(0, 0));
      } catch (e:Error) {
        trace("null source", e.errorID);
      }

      var a:BitmapData = new BitmapData(3, 1, true, 0xff112233);
      var b:BitmapData = a.clone();
      trace("same", a.compare(b));
      b.setPixel32(0, 0, 0xff102030);
      b.setPixel32(1, 0, 0x80112233);
      var diff:Object = a.compare(b);
      dump("differences", diff as BitmapData);
      trace("widths", a.compare(new BitmapData(2, 1)), "heights", a.compare(new BitmapData(3, 2)));
      try {
        a.compare(null);
      } catch (e:Error) {
        trace("null other", e.errorID);
      }
    }

    private function dump(label:String, data:BitmapData):void {
      var out:Array = [];
      for (var x:int = 0; x < data.width; x++) {
        out.push(data.getPixel32(x, 0).toString(16));
      }

      trace(label, out.join(" "));
    }
  }
}
