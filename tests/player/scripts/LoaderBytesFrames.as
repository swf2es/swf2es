// When a Loader's content from bytes comes, against the frames and the
// loads' events: a large SWF (an ABC of many classes and a megabyte of
// sounds) loaded from frame 1's script, a small one from frame 2's
// ENTER_FRAME, and the small one again from frame 3's EXIT_FRAME. One load
// a frame: of several asked in one frame, adl completes them in an order
// of its own, neither the order asked nor its reverse. Their bytes are
// DefineBinaryData that tests/player/cases.ts binds to SmallBytes and
// LargeBytes.
package {
  import flash.display.Loader;
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.events.ProgressEvent;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;
  import flash.utils.ByteArray;
  import flash.utils.getQualifiedClassName;

  public class Main extends MovieClip {
    private var frame:int = 1;
    private var small:Loader = new Loader();
    private var large:Loader = new Loader();
    private var again:Loader = new Loader();

    public function Main() {
      watch(small, "small");
      watch(large, "large");
      watch(again, "again");
      addEventListener(Event.ENTER_FRAME, onEnterFrame);
      addEventListener(Event.FRAME_CONSTRUCTED, function(e:Event):void { report("frameConstructed"); });
      addEventListener(Event.EXIT_FRAME, onExitFrame);
      addFrameScript(0, frame1);
    }

    private function onEnterFrame(e:Event):void {
      frame++;
      report("enterFrame");
      if (frame == 2) {
        load(small, new SmallBytes());
        report("small asked");
      }
    }

    private function onExitFrame(e:Event):void {
      report("exitFrame");
      if (frame == 3) {
        load(again, new SmallBytes());
        report("again asked");
      }
    }

    private function frame1():void {
      load(large, new LargeBytes());
      report("large asked");
    }

    private function load(loader:Loader, bytes:ByteArray):void {
      addChild(loader);
      var context:LoaderContext = new LoaderContext(false, new ApplicationDomain());
      context.allowCodeImport = true;
      loader.loadBytes(bytes, context);
    }

    private function watch(loader:Loader, name:String):void {
      for each (var type:String in ["open", "progress", "init", "complete", "ioError"]) {
        loader.contentLoaderInfo.addEventListener(type, function(e:Event):void {
          var progress:String = e is ProgressEvent ? " " + ProgressEvent(e).bytesLoaded + "/" + ProgressEvent(e).bytesTotal : "";
          trace(name, e.type + progress, loader.numChildren, loader.content != null);
        });
      }

      loader.addEventListener(Event.ADDED, function(e:Event):void {
        trace(name, "added", getQualifiedClassName(e.target));
      });
    }

    private function report(what:String):void {
      trace(frame, what, small.numChildren, large.numChildren, again.numChildren);
    }
  }
}
