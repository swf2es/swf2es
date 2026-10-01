// The document class of a SWF another loads: what it sees as it is
// constructed, when it reaches the stage, and on its frames.
package {
  import flash.display.MovieClip;
  import flash.events.Event;

  public class Inner extends MovieClip {
    public function Inner() {
      trace("Inner made", parent != null, stage != null, root == this, loaderInfo != null, numChildren, getChildAt(0).root == this);
      addEventListener(Event.ADDED, onAdded);
      addEventListener(Event.ADDED_TO_STAGE, onAddedToStage);
      addFrameScript(0, frame1, 1, frame2);
    }

    // Methods, not closures: a closure's `this` is the global object.
    private function onAdded(e:Event):void {
      trace("Inner added", e.target == this, e.target.parent == this, e.target == getChildAt(0), parent != null, stage != null, loaderInfo != null);
    }

    private function onAddedToStage(e:Event):void {
      trace("Inner addedToStage", e.target == this, loaderInfo.url != null, loaderInfo.content == this, root == this, parent == loaderInfo.loader, loaderInfo.loaderURL == parent.loaderInfo.url);
    }

    private function frame1():void {
      trace("inner frame 1", stage != null, loaderInfo.bytesLoaded == loaderInfo.bytesTotal, root == this, loaderInfo.content == this);
    }

    private function frame2():void {
      trace("inner frame 2");
    }
  }
}
