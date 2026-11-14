package {
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.net.URLRequest;
  public class LeakMain extends Sprite {
    private var count:int = 0;
    private var loading:Boolean = false;
    public function LeakMain() {
      addEventListener(Event.ENTER_FRAME, next);
    }
    private function next(e:Event):void {
      if (loading) {
        return;
      }
      loading = true;
      var params:Object = loaderInfo.parameters;
      var kinds:int = int(params.kinds);
      var loader:Loader = new Loader();
      loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function (e:Event):void {
        loader.unloadAndStop();
        loading = false;
        count++;
        trace("loaded " + count);
      });
      loader.load(new URLRequest("child-" + (count % kinds) + ".swf"));
    }
  }
}
