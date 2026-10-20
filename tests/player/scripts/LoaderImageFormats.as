package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class Main extends Sprite {
    // Original 1x1 PNGs and GIFs; the transparent palette/key is unused.
    private var samples:Array = [
      ["rgb", "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082"],
      ["rgba-opaque", "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082"],
      ["rgb-keyed", "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000674524e530000000000006ea607910000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082"],
      ["gif-opaque", "47494638396101000100800000000000ffffff2c00000000010001000002024401003b"],
      ["gif-gce-opaque", "47494638396101000100800000000000ffffff21f90400000001002c00000000010001000002024401003b"],
      ["gif-transparent-unused", "47494638396101000100800000000000ffffff21f90401000001002c00000000010001000002024401003b"]
    ];
    private var index:int = 0;
    private var loader:Loader = new Loader();

    public function Main() {
      loader.contentLoaderInfo.addEventListener(Event.COMPLETE, complete);
      load();
    }

    private function load():void {
      var bytes:ByteArray = new ByteArray();
      var hex:String = samples[index][1];
      for (var i:int = 0; i < hex.length; i += 2) {
        bytes.writeByte(parseInt(hex.substr(i, 2), 16));
      }
      loader.loadBytes(bytes);
    }

    private function complete(e:Event):void {
      var bitmap:BitmapData = Bitmap(loader.content).bitmapData;
      trace(samples[index][0], loader.contentLoaderInfo.contentType,
        bitmap.transparent, bitmap.getPixel32(0, 0).toString(16));
      if (++index < samples.length) {
        load();
      }
    }
  }
}
