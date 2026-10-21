package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;
  import flash.utils.Endian;

  public class Main extends Sprite {
    public function Main() {
      for each (var endian:String in [Endian.BIG_ENDIAN, Endian.LITTLE_ENDIAN]) {
        var input:ByteArray = new ByteArray();
        input.endian = endian;
        input.writeByte(99);
        for each (var color:uint in [0xFFFF0000, 0xFF00FF00, 0xFF0000FF, 0xFFFFFF00]) {
          input.writeUnsignedInt(color);
        }
        input.position = 1;
        var bmp:BitmapData = new BitmapData(2, 2, true, 0);
        bmp.setPixels(bmp.rect, input);
        trace(endian, pixels(bmp), input.position, input.length);

        var output:ByteArray = new ByteArray();
        output.endian = endian;
        output.writeByte(99);
        bmp.copyPixelsToByteArray(bmp.rect, output);
        trace("copy", endian, output.position, output.length);
        output.position = 1;
        trace(output.readUnsignedInt().toString(16), output.readUnsignedInt().toString(16));

        var fresh:ByteArray = bmp.getPixels(bmp.rect);
        trace("get", fresh.endian, fresh.position);
        fresh.position = 0;
        trace("get word", fresh.readUnsignedInt().toString(16));

        input.length = 8;
        input.position = 1;
        bmp.fillRect(bmp.rect, 0xFF123456);
        try {
          bmp.setPixels(new Rectangle(-1, 0, 3, 2), input);
        } catch (error:Error) {
          trace("partial", error.errorID, input.position, pixels(bmp));
        }
        bmp.setPixels(new Rectangle(10, 10, 1, 1), input);
        trace("empty", input.position);
      }
    }

    private function pixels(bmp:BitmapData):String {
      return bmp.getPixel32(0, 0).toString(16) + " " + bmp.getPixel32(1, 0).toString(16) + " " +
        bmp.getPixel32(0, 1).toString(16) + " " + bmp.getPixel32(1, 1).toString(16);
    }
  }
}
