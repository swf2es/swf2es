package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.geom.Point;

  // BitmapData.perlinNoise: each pixel of small bitmaps under the options
  // content uses, summed, and a few as they are.
  public class PerlinNoise extends Sprite {
    public function PerlinNoise() {
      run("turbulence", 24, 1, 20, 12, 3, 7, false, false, false, null);
      run("fractal", 24, 1, 20, 12, 3, 7, false, true, false, null);
      run("gray alpha", 24, 1, 20, 12, 2, 15, true, true, true, null);
      run("stitched", 16, 1, 7, 9, 2, 1, false, true, true, null);
      run("blue and alpha", 24, 1, 10, 30, 1, 12, false, true, true, null);
      run("offsets", 24, 1, 15, 15, 2, 7, false, true, false,
        [new Point(3, 4), new Point(-10, 2.5)]);
      run("opaque", 24, 1, 15, 15, 1, 15, false, false, false, null, false);
      run("negative seed", 12, -77, 6, 8, 4, 7, false, false, false, null);
      // So many octaves take the lattice past an int, where Flash's noise goes wild.
      for each (var octaves:Number in [34, 36, 40, 2000, -1]) {
        run("octaves " + octaves, 8, 1, 10, 10, octaves, 7, false, true, false, null);
        run("turbulent octaves " + octaves, 8, 1, 10, 10, octaves, 15, true, false, true, null);
      }
    }

    private function run(label:String, size:int, seed:int, baseX:Number, baseY:Number,
        octaves:Number, channels:uint, gray:Boolean, fractal:Boolean, stitch:Boolean,
        offsets:Array, transparent:Boolean = true):void {
      var data:BitmapData = new BitmapData(size, size / 2, transparent, 0);
      data.perlinNoise(baseX, baseY, octaves, seed, stitch, fractal, channels, gray, offsets);
      var sum:uint = 0;
      for (var y:int = 0; y < data.height; y++) {
        for (var x:int = 0; x < data.width; x++) {
          sum = (sum * 31 + data.getPixel32(x, y)) >>> 0;
        }
      }

      trace(label, sum.toString(16), data.getPixel32(0, 0).toString(16),
        data.getPixel32(size - 1, size / 2 - 1).toString(16), data.getPixel32(size / 2, 2).toString(16));
    }
  }
}
