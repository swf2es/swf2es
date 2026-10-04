// The main SWF's loaderInfo.parameters, its URL's query and the host's
// flashvars, as the stage and the root tell them, and those of SWFs loaded
// by URL: the URL's query from the second PROGRESS on, or the
// LoaderContext's parameters in its place from the call on. Driven by a
// node test with a stub for the host's fetch; Flash's harness can give
// neither flashvars nor a URL of the main SWF's own.
package {
  import flash.display.Loader;
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.events.ProgressEvent;
  import flash.net.URLRequest;
  import flash.system.LoaderContext;

  public class FlashVars extends MovieClip {
    private var loaders:Array = [];

    public function FlashVars() {
      trace("main", dump(loaderInfo.parameters), dump(stage.loaderInfo.parameters), dump(root.loaderInfo.parameters));
      load("query", "inner.swf?k=1&k=2&t&=v&w=x=y+z&s=%E2%82%AC#k=3", null);
      load("given", "inner.swf?k=1", {g: "ctx"});
      addFrameScript(1, frame2);
    }

    private function frame2():void {
      for each (var loader:Loader in loaders) {
        trace("loaded", Object(loader.content).seen, dump(loader.contentLoaderInfo.parameters));
      }
    }

    private function load(name:String, url:String, parameters:Object):void {
      var loader:Loader = new Loader();
      var info:* = loader.contentLoaderInfo;
      for each (var type:String in [Event.OPEN, ProgressEvent.PROGRESS, Event.INIT]) {
        info.addEventListener(type, function(e:Event):void {
          trace(name, e.type, dump(info.parameters));
        });
      }
      var context:LoaderContext = new LoaderContext();
      context.parameters = parameters;
      loader.load(new URLRequest(url), context);
      loaders.push(loader);
      trace(name, "after", dump(info.parameters));
    }

    private static function dump(p:Object):String {
      var pairs:Array = [];
      for (var name:String in p) {
        pairs.push(name + "=" + p[name]);
      }

      pairs.sort();
      return "{" + pairs.join(",") + "}";
    }
  }
}
