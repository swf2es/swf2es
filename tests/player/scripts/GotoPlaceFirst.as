package {
  import flash.display.MovieClip;
  import flash.events.Event;

  // A goto that places a clip holding a button whose up state is a clip,
  // whose early frame broadcasts FRAME_CONSTRUCTED, then a named clip after
  // it: the listener sees that clip already made, as Flash places a goto's
  // children before it makes any alive.
  public class Main extends MovieClip {
    public var holder:MovieClip;
    public var setup:MovieClip;
    private var events:int = 0;

    public function Main() {
      addEventListener(Event.FRAME_CONSTRUCTED, constructed);
      addFrameScript(0, frame1, 2, frame3);
    }

    private function constructed(e:Event):void {
      if (events++ < 6) {
        trace("frameConstructed", currentFrame, "holder", holder != null, "setup", setup != null);
      }
    }

    private function frame1():void {
      trace("frame 1 goto 3");
      gotoAndStop(3);
      trace("after goto", "holder", holder != null, "setup", setup != null);
    }

    private function frame3():void {
      trace("frame 3", "holder", holder != null, "setup", setup != null);
    }
  }

  public class State extends MovieClip {
    public function State() {
      trace("state constructor");
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      trace("state frame 1");
    }
  }

  public class Holder extends MovieClip {
    public function Holder() {
      trace("holder constructor");
    }
  }

  public class Setup extends MovieClip {
    public function Setup() {
      trace("setup constructor");
    }
  }
}
