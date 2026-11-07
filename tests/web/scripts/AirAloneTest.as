package {
  import flash.desktop.NativeApplication;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.InvokeEvent;
  import flash.filesystem.File;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.system.Security;

  // A SWF that names AIR's classes, played alone by its URL: as an AIR
  // application whose directory holds it alone, its other files loaded
  // from beside it on the server, and its exit once that is done.
  public class AirAloneTest extends Sprite {
    public function AirAloneTest() {
      trace("alone: url " + loaderInfo.url);
      trace("alone: sandbox " + Security.sandboxType);
      trace("alone: id " + NativeApplication.nativeApplication.applicationID);
      trace("alone: title " + stage.nativeWindow.title);
      NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, invoked);
    }

    private function invoked(e:InvokeEvent):void {
      var names:Array = [];
      var listing:Array = File.applicationDirectory.getDirectoryListing();
      for (var i:int = 0; i < listing.length; i++) {
        names.push(listing[i].name);
      }

      trace("alone: listing " + names.join(","));
      var loader:URLLoader = new URLLoader();
      loader.addEventListener(Event.COMPLETE, function (e:Event):void {
        trace("alone: beside " + loader.data);
        NativeApplication.nativeApplication.exit(5);
      });
      loader.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("alone: beside refused");
        NativeApplication.nativeApplication.exit(5);
      });
      loader.load(new URLRequest("data/hello.txt"));
    }
  }
}
