// The display list's events: ADDED and ADDED_TO_STAGE for a child the
// timeline places and one a script adds, REMOVED and REMOVED_FROM_STAGE
// when they go, with who hears what and in which order. The script's part
// runs from the first frame's script, when the root is on the stage in a
// main movie and as loaded content alike; in a constructor the two differ.
package {
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.events.Event;

  public class Box extends MovieClip {
    public function Box() {
      addEventListener(Event.ADDED, function(e:Event):void {
        trace("box added", e.target == e.currentTarget, e.bubbles, parent != null);
      });
      addEventListener(Event.ADDED_TO_STAGE, function(e:Event):void {
        trace("box addedToStage", stage != null, parent != null);
      });
      addEventListener(Event.REMOVED, function(e:Event):void {
        trace("box removed", parent != null);
      });
      addEventListener(Event.REMOVED_FROM_STAGE, function(e:Event):void {
        trace("box removedFromStage", stage != null);
      });
      trace("Box made", parent != null);
    }
  }

  public class Main extends MovieClip {
    // Nothing traced here: when the timeline's Box hears ADDED_TO_STAGE,
    // relative to the constructor, differs between a main movie and loaded
    // content, whose root joins the stage after it is constructed.
    public function Main() {
      addFrameScript(0, frame1, 1, frame2);
    }

    private function frame1():void {
      trace("frame 1", numChildren, stage != null);
      addEventListener(Event.ADDED, function(e:Event):void {
        trace("root hears added", e.target is Box, e.eventPhase);
      });
      addEventListener(Event.REMOVED, function(e:Event):void {
        trace("root hears removed", e.target is Box, e.eventPhase);
      });
      var box:Box = new Box();
      var holder:Sprite = new Sprite();
      holder.addChild(box);
      trace("in holder", box.stage != null);
      addChild(holder);
      trace("holder added", box.stage != null);
      removeChild(holder);
      trace("holder removed", box.stage != null);
      addChild(box);
      trace("box added to root");
    }

    private function frame2():void {
      trace("frame 2", numChildren);
    }
  }
}
