package {
  import flash.desktop.NativeApplication;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.InvokeEvent;
  import flash.filesystem.File;
  import flash.filesystem.FileMode;
  import flash.filesystem.FileStream;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.system.Security;

  // An AIR application a page plays from its package: its URL, sandbox,
  // window and launch; what File finds in its directory and AIR's others;
  // a file read by its app: URL, by its file: URL, and a missing one, and
  // by a FileStream at once and over frames; and its exit, once the reads
  // are done.
  public class AirWebTest extends Sprite {
    private var _pending:int = 4;

    public function AirWebTest() {
      trace("air: url " + loaderInfo.url);
      trace("air: sandbox " + Security.sandboxType);
      trace("air: id " + NativeApplication.nativeApplication.applicationID);
      trace("air: window " + stage.nativeWindow.title + " " + stage.nativeWindow.bounds.width + "x" + stage.nativeWindow.bounds.height);
      NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, invoked);
    }

    private function invoked(e:InvokeEvent):void {
      trace("air: invoke " + e.arguments.join("|") + " " + e.currentDirectory.exists);
      var data:File = File.applicationDirectory.resolvePath("data/hello.txt");
      trace("air: files " + data.exists + " " + data.size + " " + File.applicationDirectory.resolvePath("missing.txt").exists + " " + File.applicationStorageDirectory.exists + " " + File.documentsDirectory.isDirectory);
      var names:Array = [];
      var listing:Array = File.applicationDirectory.getDirectoryListing();
      for (var i:int = 0; i < listing.length; i++) {
        names.push(listing[i].name);
      }

      trace("air: listing " + names.join(","));
      var stream:FileStream = new FileStream();
      stream.open(data, FileMode.READ);
      trace("air: stream " + stream.readUTFBytes(stream.bytesAvailable));
      stream.close();
      var async:FileStream = new FileStream();
      async.addEventListener(Event.COMPLETE, function (e:Event):void {
        trace("air: async stream " + async.readUTFBytes(async.bytesAvailable));
        async.close();
        done();
      });
      async.openAsync(data, FileMode.READ);
      load("app", data.url);
      load("file", new File(data.nativePath).url);
      load("missing", "app:/missing.txt");
    }

    private function load(label:String, url:String):void {
      var loader:URLLoader = new URLLoader();
      loader.addEventListener(Event.COMPLETE, function (e:Event):void {
        trace("air: " + label + " " + loader.data);
        done();
      });
      loader.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("air: " + label + " refused");
        done();
      });
      loader.load(new URLRequest(url));
    }

    private function done():void {
      _pending--;
      if (_pending == 0) {
        trace("air: exit");
        NativeApplication.nativeApplication.exit(3);
      }
    }
  }
}
