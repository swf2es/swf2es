// The document class of a loaded SWF that asks its own Loader for another
// SWF from its constructor: it must never attach. Driven by a node test;
// Flash does not run it.
package {
  import flash.display.Loader;
  import flash.display.MovieClip;
  import flash.net.URLRequest;

  public class Replacer extends MovieClip {
    public function Replacer() {
      Loader(loaderInfo.loader).load(new URLRequest("inner.swf"));
      trace("replaced from constructor", loaderInfo.content == null, loaderInfo.bytesTotal);
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      trace("replacer frame 1");
    }
  }
}
