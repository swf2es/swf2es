package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;

  // BitmapData.applyFilter and generateFilterRect with a
  // DisplacementMapFilter against adl: which pixel each one takes, by the
  // map's channels, scale and point; the four modes past the source; a map
  // smaller than the source and transparent in places; a subrect and an
  // opaque destination.
  public class DisplacementMap extends Sprite {
    private var src:BitmapData;

    /** A 12 by 8 source, each pixel its own: red its x, green its y. */
    private function source(transparent:Boolean = true):BitmapData {
      var b:BitmapData = new BitmapData(12, 8, transparent, 0);
      for (var y:int = 0; y < 8; y++) {
        for (var x:int = 0; x < 12; x++) {
          b.setPixel32(x, y, (transparent && (x + y) % 5 == 0 ? 0x80000000 : 0xff000000) | (x * 20) << 16 | (y * 30) << 8 | 0x40);
        }
      }
      return b;
    }

    /** A map filled with one colour. */
    private function flat(color:uint, w:int = 12, h:int = 8):BitmapData {
      return new BitmapData(w, h, true, color);
    }

    private function run(label:String, f:DisplacementMapFilter, rect:Rectangle = null, at:Point = null, into:BitmapData = null):void {
      var d:BitmapData = into || new BitmapData(12, 8, true, 0xff0000ff);
      try {
        d.applyFilter(src, rect || src.rect, at || new Point(0, 0), f);
      } catch (e:Error) {
        trace(label, "error", e.errorID);
        return;
      }
      trace(label);
      for (var y:int = 0; y < d.height; y++) {
        var row:Array = [];
        for (var x:int = 0; x < d.width; x++) {
          var p:uint = d.getPixel32(x, y);
          row.push(p == 0xff0000ff ? "." : p == 0 ? "0" : p.toString(16));
        }
        trace(" " + row.join(" "));
      }
    }

    public function DisplacementMap() {
      src = source();
      var R:uint = BitmapDataChannel.RED, G:uint = BitmapDataChannel.GREEN;
      var B:uint = BitmapDataChannel.BLUE, A:uint = BitmapDataChannel.ALPHA;
      // Constant maps: how far each value moves, by scale.
      run("128 none", new DisplacementMapFilter(flat(0xff808080), new Point(0, 0), R, G, 10, 10));
      run("red 160 x 8", new DisplacementMapFilter(flat(0xffa08080), new Point(0, 0), R, G, 8, 8));
      run("red 96 x 8", new DisplacementMapFilter(flat(0xff608080), new Point(0, 0), R, G, 8, 8));
      run("red 255 x 2", new DisplacementMapFilter(flat(0xffff8080), new Point(0, 0), R, G, 2, 0));
      run("red 0 x 2", new DisplacementMapFilter(flat(0xff008080), new Point(0, 0), R, G, 2, 0));
      run("green 144 x 12", new DisplacementMapFilter(flat(0xff809080), new Point(0, 0), R, G, 0, 12));
      run("scale 3.3", new DisplacementMapFilter(flat(0xffc0c080), new Point(0, 0), R, G, 3.3, -3.3));
      run("scale 0.5", new DisplacementMapFilter(flat(0xffff0080), new Point(0, 0), R, G, 0.5, 0.5));
      run("blue alpha", new DisplacementMapFilter(flat(0xa08080c0), new Point(0, 0), B, A, 6, 6));
      run("same channel", new DisplacementMapFilter(flat(0xffc08080), new Point(0, 0), R, R, 4, 4));
      run("two channels", new DisplacementMapFilter(flat(0xffc04080), new Point(0, 0), R | G, G, 4, 4));
      // A map whose pixels differ: each moves by its own.
      var ramp:BitmapData = new BitmapData(12, 8, true, 0);
      for (var y:int = 0; y < 8; y++) for (var x:int = 0; x < 12; x++) ramp.setPixel32(x, y, 0xff000080 | ((x * 23) & 0xff) << 16 | ((y * 37) & 0xff) << 8);
      run("ramp", new DisplacementMapFilter(ramp, new Point(0, 0), R, G, 6, 6));
      // Transparent and half map pixels, premultiplied as the store keeps them.
      var holes:BitmapData = flat(0xffc0c080);
      holes.setPixel32(2, 2, 0x00000000);
      holes.setPixel32(4, 2, 0x80c0c080);
      holes.setPixel32(6, 2, 0x40ffff80);
      run("map alpha", new DisplacementMapFilter(holes, new Point(0, 0), R, G, 8, 8));
      // The modes, moving far past the source.
      for each (var mode:String in ["wrap", "clamp", "ignore", "color"]) {
        run("mode " + mode, new DisplacementMapFilter(flat(0xffe0e080), new Point(0, 0), R, G, 20, 12, mode, 0x00ff00, 0.5));
        run("mode " + mode + " back", new DisplacementMapFilter(flat(0xff202080), new Point(0, 0), R, G, 20, 12, mode, 0xff0000, 1));
      }
      // A small map, placed: past it the pixels stay.
      run("small map", new DisplacementMapFilter(flat(0xffc0c080, 4, 3), new Point(3, 2), R, G, 8, 8));
      run("map off", new DisplacementMapFilter(flat(0xffc0c080, 4, 3), new Point(-2, -1), R, G, 8, 8));
      run("small map color", new DisplacementMapFilter(flat(0xffff8080, 4, 3), new Point(3, 2), R, G, 30, 0, "color", 0xff00ff, 1));
      // No map.
      run("no map", new DisplacementMapFilter(null, new Point(0, 0), R, G, 8, 8));
      // A subrect undisplaced, moved. (Displaced, adl fills the grown rect
      // from the source rect's corner, shifted, and into an opaque
      // destination it leaves alpha: quirks swf2es does not take on.)
      run("subrect", new DisplacementMapFilter(flat(0xff808080), new Point(0, 0), R, G, 8, 8), new Rectangle(2, 1, 6, 5), new Point(4, 2));
      var o:BitmapData = source(false);
      var od:BitmapData = new BitmapData(12, 8, true, 0xff0000ff);
      od.applyFilter(o, o.rect, new Point(0, 0), new DisplacementMapFilter(flat(0xffe0e080), new Point(0, 0), R, G, 20, 12, "color", 0x00ff00, 0.5));
      src = o;
      run("opaque source color", new DisplacementMapFilter(flat(0xffe0e080), new Point(0, 0), R, G, 20, 12, "color", 0x00ff00, 0.5));
      src = source();
      // In place.
      var self:BitmapData = source();
      self.applyFilter(self, self.rect, new Point(0, 0), new DisplacementMapFilter(flat(0xffa0a080), new Point(0, 0), R, G, 8, 8));
      var rows:Array = [];
      for (var yy:int = 0; yy < 8; yy++) { var r:Array = []; for (var xx:int = 0; xx < 12; xx++) r.push(self.getPixel32(xx, yy).toString(16)); rows.push(" " + r.join(" ")); }
      trace("in place\n" + rows.join("\n"));
      // The map's pixels when the filter is applied, or when it was set.
      var live:BitmapData = flat(0xff808080);
      var lf:DisplacementMapFilter = new DisplacementMapFilter(live, new Point(0, 0), R, G, 8, 8);
      live.fillRect(live.rect, 0xffc0c080);
      run("map changed after", lf);
      var b40:BitmapData = new BitmapData(40, 40);
      var big:BitmapData = new BitmapData(2000, 2000);
      var grows:Array = [];
      for each (var sc:Number in [0, 3, 4, 7.9, 8, 16, 100, 255, -8]) {
        var g:Rectangle = big.generateFilterRect(new Rectangle(500, 500, 10, 10), new DisplacementMapFilter(flat(0xffc0c080, 4, 4), new Point(0, 0), R, G, sc, sc / 2));
        grows.push(sc + ":" + (500 - g.x) + "," + (500 - g.y));
      }
      trace("rect grows", grows.join(" "));
      trace("rect", b40.generateFilterRect(new Rectangle(5, 5, 10, 10), lf),
        b40.generateFilterRect(new Rectangle(5, 5, 10, 10), new DisplacementMapFilter(flat(0xffc0c080, 4, 3), new Point(30, 30), R, G, 100, 100)),
        b40.generateFilterRect(new Rectangle(30, 30, 20, 20), lf),
        b40.generateFilterRect(new Rectangle(5, 5, 10, 10), new DisplacementMapFilter(null, new Point(0, 0), R, G, 8, 8)),
        b40.generateFilterRect(new Rectangle(30, 30, 20, 20), new BlurFilter(8, 8)),
        b40.generateFilterRect(new Rectangle(-10, -10, 20, 20), new GlowFilter()));
    }
  }
}
