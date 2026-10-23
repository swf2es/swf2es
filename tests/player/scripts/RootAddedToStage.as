package {
  import flash.display.Sprite;
  import flash.events.Event;

  // The document class is told it was added to the stage once its
  // constructor has returned, though it was on it already, as Flash and AIR
  // tell a main SWF's root: content that waits for addedToStage to start
  // runs. ADDED comes before it, but twice to the root of a SWF that a
  // Loader loads, as Flash's references are made, so it is left out here.
  public class RootAddedToStage extends Sprite {
    private var frames:int = 0;

    public function RootAddedToStage() {
      addEventListener(Event.ADDED_TO_STAGE, function(e:Event):void {
        trace("addedToStage " + (stage != null) + " " + e.bubbles + " frames " + frames);
      });
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        frames++;
        if (frames == 2) {
          trace("entered " + frames + " " + (stage != null));
        }
      });
      trace("constructed");
    }
  }
}
