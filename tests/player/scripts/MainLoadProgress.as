package {
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.events.ProgressEvent;

  // URL loading delivers final progress after this frame script subscribes. loadBytes does not.
  public class MainLoadProgress extends MovieClip {
    public function MainLoadProgress() {
      loaderInfo.addEventListener(Event.INIT, status);
      loaderInfo.addEventListener(Event.COMPLETE, status);
      addFrameScript(0, first, 1, second);
    }

    private function first():void {
      stop();
      loaderInfo.addEventListener(ProgressEvent.PROGRESS, loaded);
      trace("frame", currentFrame);
    }

    private function loaded(e:ProgressEvent):void {
      if (e.bytesLoaded != e.bytesTotal) {
        return;
      }

      trace("progress", currentFrame, e.target == loaderInfo, e.bytesLoaded > 0,
        loaderInfo.bytesLoaded == e.bytesLoaded, loaderInfo.bytesTotal == e.bytesTotal);
      loaderInfo.removeEventListener(ProgressEvent.PROGRESS, loaded);
      gotoAndPlay(2);
    }

    private function second():void {
      stop();
      trace("frame", currentFrame);
    }

    private function status(e:Event):void {
      trace(e.type, currentFrame);
    }
  }
}
