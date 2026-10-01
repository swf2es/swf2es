// A SWF loading others by URL: one that is there, one that is not, the
// first again, into the one domain there is, one that loads another in
// turn, one closed before it comes, one replaced by a second load, the
// first loaded again once complete, one unloaded before it comes, one
// replaced from its OPEN listener, one unloaded again from REMOVED, one
// whose content replaces it from its own constructor, one from bytes
// closed from its first PROGRESS, and one whose old content loads anew
// from REMOVED as it is replaced.
// Driven by a node test with a stub for the host's fetch; Flash does not
// run it.
package {
  import flash.display.Loader;
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.ProgressEvent;
  import flash.net.URLRequest;
  import flash.utils.getQualifiedClassName;

  public class Main extends MovieClip {
    private var loaders:Array = [];

    public function Main() {
      addFrameScript(0, frame1, 1, frame2, 2, frame3, 3, frame4, 4, frame5, 5, frame6);
    }

    private function frame1():void {
      load("inner.swf");
      load("missing.swf");
    }

    private function frame2():void {
      load("inner.swf");
      load("nested.swf");
      load("inner.swf").close();
      load("missing.swf").load(new URLRequest("inner.swf"));
    }

    private function frame3():void {
      trace("frame 3", counts());
      var info:* = loaders[0].contentLoaderInfo;
      trace("before reload", loaders[0].content != null, info.bytesTotal, info.swfVersion);
      loaders[0].load(new URLRequest("inner.swf"));
      trace("after reload", loaders[0].content == null, loaders[0].numChildren, info.bytesTotal, info.url == null, inaccessible(info));
      load("inner.swf").unload();
      var replacing:Loader = load("inner.swf");
      var replaced:Boolean = false;
      replacing.contentLoaderInfo.addEventListener(Event.OPEN, function(e:Event):void {
        if (replaced) {
          return;
        }

        replaced = true;
        replacing.load(new URLRequest("nested.swf"));
        trace("replaced from open", replacing.content == null, replacing.contentLoaderInfo.bytesTotal);
      });
    }

    private function frame4():void {
      trace("frame 4", counts(), Loader(MovieClip(loaders[3].content).getChildAt(0)).numChildren);
      var removed:int = 0;
      loaders[2].content.addEventListener(Event.REMOVED, function(e:Event):void {
        removed++;
        loaders[2].unload();
      });
      loaders[2].unload();
      trace("unloaded from removed", removed, loaders[2].numChildren, loaders[2].content == null);
      load("replacer.swf");
    }

    private function frame5():void {
      trace("frame 5", counts(), getQualifiedClassName(loaders[7].content));
      // From bytes, the progress comes in the call; closing from the first ends it there.
      var closing:Loader = new Loader();
      loaders.push(closing);
      closing.contentLoaderInfo.addEventListener(ProgressEvent.PROGRESS, function(e:ProgressEvent):void {
        trace("9 progress", e.bytesLoaded + "/" + e.bytesTotal);
        closing.close();
      });
      addChild(closing);
      closing.loadBytes(loaders[0].contentLoaderInfo.bytes);
      // The content being replaced loads another from REMOVED: that load is the one that counts.
      loaders[5].content.addEventListener(Event.REMOVED, function(e:Event):void {
        loaders[5].load(new URLRequest("nested.swf"));
        trace("loaded from removed");
      });
      loaders[5].load(new URLRequest("inner.swf"));
    }

    private function frame6():void {
      trace("frame 6", counts(), getQualifiedClassName(loaders[8].content), getQualifiedClassName(loaders[5].content));
    }

    private function counts():Array {
      var counts:Array = [];
      for each (var loader:Loader in loaders) {
        counts.push(loader.numChildren);
      }

      return counts;
    }

    /** Whether the SWF's facts are refused, as Flash refuses them before the SWF is loaded. */
    private function inaccessible(info:*):Boolean {
      try {
        info.actionScriptVersion;
        return false;
      } catch (e:Error) {
        return e.errorID == 2099;
      }
    }

    private function load(url:String):Loader {
      var loader:Loader = new Loader();
      var index:int = loaders.push(loader) - 1;
      var report:Function = function(e:Event):void {
        var p:ProgressEvent = e as ProgressEvent;
        trace(index, e.type, p ? p.bytesLoaded + "/" + p.bytesTotal : (e is IOErrorEvent ? IOErrorEvent(e).text : "-"), loader.contentLoaderInfo.url, loader.content != null);
      };
      for each (var type:String in [Event.OPEN, ProgressEvent.PROGRESS, Event.INIT, Event.COMPLETE, IOErrorEvent.IO_ERROR]) {
        loader.contentLoaderInfo.addEventListener(type, report);
      }
      addChild(loader);
      loader.load(new URLRequest(url));
      trace(index, "requested", url);
      return loader;
    }
  }
}
