package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class Main extends Sprite {
    public function Main() {
      var loader:Loader = new Loader();
      loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
        var bitmap:BitmapData = Bitmap(loader.content).bitmapData;
        for (var y:int = 0; y < 8; y++) {
          var row:Array = [];
          for (var x:int = 0; x < 8; x++) {
            row.push(bitmap.getPixel32(x, y).toString(16));
          }
          trace(row.join(","));
        }
      });
      // Original grayscale PNG: columns 0,1,63,127,128,191,254,255;
      // rows have alpha 0,1,2,64,127,128,254,255.
      var hex:String = "89504e470d0a1a0a0000000d4948445200000008000000080806000000c40fbe8b0000008349444154789c2dcac11103311002c14589ad3283ccc80c5caaf37ca7676606c0ecee901c49637b924cdbf97f6077411292601b49d0160f1c0067770fc923e9d83e494edbf3c0057077f792bc92aeed9be4b6bd0f100077972f49b4cd246ccb070440bbabef4bb695446df540006477433292623bafb679a000babb255949b5ddefb73f26d77981a32c2e1e0000000049454e44ae426082";
      var bytes:ByteArray = new ByteArray();
      for (var i:int = 0; i < hex.length; i += 2) {
        bytes.writeByte(parseInt(hex.substr(i, 2), 16));
      }
      loader.loadBytes(bytes);
    }
  }
}
