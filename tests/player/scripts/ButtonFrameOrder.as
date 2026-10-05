package {
  import flash.display.MovieClip;
  import flash.events.Event;

  public class State extends MovieClip {
    private static var count:int = 0;
    private var id:int;

    public function State() {
      id = ++count;
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      trace("state", id, "frame 1");
    }
  }

  public class Child extends MovieClip {
    private static var count:int = 0;
    private var id:int;

    public function Child() {
      id = ++count;
      trace("child", id, "constructor");
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      trace("child", id, "frame 1");
    }
  }

  public class Container extends MovieClip {
    private static var count:int = 0;
    private var id:int;

    public function Container() {
      id = ++count;
      trace("container", id, "constructor");
      super();
      trace("container", id, "addFrameScript");
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      trace("container", id, "frame 1");
    }
  }

  // Its frame script is there before super() makes its button.
  public class Early extends MovieClip {
    private static var count:int = 0;
    private var id:int;

    public function Early() {
      id = ++count;
      trace("early", id, "addFrameScript");
      addFrameScript(0, frame1);
      super();
      trace("early", id, "constructed");
    }

    private function frame1():void {
      trace("early", id, "frame 1");
    }
  }

  public class Menu extends MovieClip {
    private static var count:int = 0;
    private var id:int;

    public function Menu() {
      id = ++count;
      trace("menu", id, "constructor");
      super();
      trace("menu", id, "addFrameScript");
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      trace("menu", id, "frame 1");
    }
  }

  public class Other extends MovieClip {
    private static var count:int = 0;
    private var id:int;

    public function Other() {
      id = ++count;
      trace("other", id, "constructor");
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      trace("other", id, "frame 1");
    }
  }

  public class Main extends MovieClip {
    private var kept:Array = [];

    public function Main() {
      addFrameScript(0, frame1, 1, frame2, 3, frame4, 5, frame6, 7, frame8);
      addEventListener(Event.ENTER_FRAME, onFrame);
      addEventListener(Event.FRAME_CONSTRUCTED, onConstructed);
    }

    private function frame1():void {
      trace("main frame 1");
    }

    private function frame2():void {
      trace("main frame 2");
    }

    // Made in a frame script, as frame_script_button_order makes its container.
    private function frame4():void {
      trace("main frame 4");
      kept.push(new Other());
      addChild(new Menu());
      trace("main frame 4 attached");
      kept.push(new Other());
    }

    // Frame 8 places a container, made in this goto's cycle.
    private function frame6():void {
      trace("main frame 6, goto 8");
      gotoAndStop(8);
      trace("main frame 6 after goto");
    }

    private function frame8():void {
      trace("main frame 8");
    }

    // Made after the frame's construct phase, before its frame scripts.
    private function onConstructed(event:Event):void {
      if (currentFrame != 5) {
        return;
      }

      removeEventListener(Event.FRAME_CONSTRUCTED, onConstructed);
      trace("frame 5 constructed");
      addChild(new Menu());
      trace("frame 5 attached");
    }

    private function onFrame(event:Event):void {
      if (currentFrame != 3) {
        return;
      }

      trace("enter frame 3");
      kept.push(new Other());
      addChild(new Menu());
      addChild(new Early());
      trace("enter frame 3 attached");
    }
  }
}
