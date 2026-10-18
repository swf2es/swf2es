package {
  import flash.display.*;
  import flash.geom.*;

  // pixelDissolve's answers and perlinNoise's bases as adl gives them to
  // AS3, beside AVM1's (the corpus's bitmap_data_thorough): seeds past the
  // generator's states and negative ones, counts of 0, rects a pixel high,
  // an opaque destination; and noise of negative bases, stitched or not.
  public class DissolveNoise extends Sprite {
    public function DissolveNoise() {
      var seeds:Array = [0, 1, 4, 7, 10, 100, -1, -2];
      var counts:Array = [0, 1, 2, 3, 40];
      var sizes:Array = [[2, 2], [3, 3], [2, 1]];
      for (var z:int = 0; z < sizes.length; z++) {
        for (var i:int = 0; i < seeds.length; i++) {
          var line:String = sizes[z][0] + "x" + sizes[z][1] + " " + seeds[i] + ":";
          for (var j:int = 0; j < counts.length; j++) {
            var src:BitmapData = new BitmapData(5, 5, true, 0x12345678);
            var dest:BitmapData = new BitmapData(5, 5, true, 0xAABBCCDD);
            var rect:Rectangle = new Rectangle(0, 0, sizes[z][0], sizes[z][1]);
            line += " " + dest.pixelDissolve(src, rect, new Point(1, 1), seeds[i], counts[j], 0);
          }

          trace(line);
        }
      }

      var opaque:BitmapData = new BitmapData(3, 3, false, 0xFFBBCCDD);
      opaque.pixelDissolve(new BitmapData(3, 3, true, 0x12345678), new Rectangle(0, 0, 2, 2), new Point(1, 1), 100, 40);
      // Its getPixel32 reads 12040608, the alpha Flash keeps in an opaque bitmap, which a store here does not.
      trace("opaque " + opaque.getPixel(1, 1).toString(16));
      var bases:Array = [[3, 5], [-3, 5], [3, -5], [-2.5, -4], [-1, 3]];
      for (var b:int = 0; b < bases.length; b++) {
        for (var stitch:int = 0; stitch < 2; stitch++) {
          var noise:BitmapData = new BitmapData(6, 6, true, 0);
          noise.perlinNoise(bases[b][0], bases[b][1], 2, 100, stitch == 1, false, 15, false, [new Point(1, 2), new Point(-3, 0.5)]);
          trace(bases[b] + " " + stitch + ": " + noise.getPixel32(0, 0).toString(16) + " " + noise.getPixel32(1, 0).toString(16) + " " + noise.getPixel32(4, 5).toString(16));
        }
      }
    }
  }
}
