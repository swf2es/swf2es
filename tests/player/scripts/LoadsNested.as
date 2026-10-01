// The document class of a loaded SWF that loads another in turn: the
// one it loads must report this SWF as its loaderURL. Driven by a node
// test; Flash does not run it.
package {
  import flash.display.Loader;
  import flash.display.MovieClip;
  import flash.net.URLRequest;

  public class LoadsNested extends MovieClip {
    public function LoadsNested() {
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      var loader:Loader = new Loader();
      addChild(loader);
      loader.load(new URLRequest("deep.swf"));
      trace("nested requested deep.swf");
    }
  }
}
