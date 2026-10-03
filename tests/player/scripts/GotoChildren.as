// What a clip's goto does to the children it keeps: each body below holds
// a looping kid, and another in a one-frame mid clip, and jumps or stops in
// its own way; Main traces every frame where each body and its kids are,
// at ENTER_FRAME and at EXIT_FRAME, beside a body that never jumps and a
// loop on the root. Same goes to the frame it is on at every ENTER_FRAME,
// Nested jumps and sends its kid to a frame in one script, and Pooled is
// taken off, sent to a frame while off, and put back three frames later.
package {
  import flash.display.MovieClip;
  import flash.events.Event;

  // From frame 2's script, forward to 8 playing; 8's script stops.
  public class Forward extends MovieClip {
    public var kid:MovieClip;
    public var mid:MovieClip;

    public function Forward() {
      addFrameScript(1, function():void { gotoAndPlay(8); }, 7, function():void { stop(); });
    }
  }

  // From frame 2's script, forward to 8 stopped.
  public class ForwardStop extends MovieClip {
    public var kid:MovieClip;
    public var mid:MovieClip;

    public function ForwardStop() {
      addFrameScript(1, function():void { gotoAndStop(8); });
    }
  }

  // From frame 5's script, back to 2, once.
  public class Back extends MovieClip {
    public var kid:MovieClip;
    public var mid:MovieClip;
    private var done:Boolean = false;

    public function Back() {
      addFrameScript(4, function():void {
        if (!done) {
          done = true;
          gotoAndPlay(2);
        }
      });
    }
  }

  // From frame 2's script, forward to 8 playing on.
  public class ForwardPlay extends MovieClip {
    public var kid:MovieClip;
    public var mid:MovieClip;

    public function ForwardPlay() {
      addFrameScript(1, function():void { gotoAndPlay(8); });
    }
  }

  // Frame 2's script stops it, no jump.
  public class Stopper extends MovieClip {
    public var kid:MovieClip;
    public var mid:MovieClip;

    public function Stopper() {
      addFrameScript(1, function():void { stop(); });
    }
  }

  // From an ENTER_FRAME listener on frame 2, forward to 8 playing.
  public class Listener extends MovieClip {
    public var kid:MovieClip;
    public var mid:MovieClip;
    private var done:Boolean = false;

    public function Listener() {
      addEventListener(Event.ENTER_FRAME, function(_:Event):void {
        if (!done && currentFrame == 2) {
          done = true;
          gotoAndPlay(8);
        }
      });
    }
  }

  // At every ENTER_FRAME, to the frame it is on, playing on.
  public class Same extends MovieClip {
    public var kid:MovieClip;
    public var mid:MovieClip;

    public function Same() {
      addEventListener(Event.ENTER_FRAME, function(_:Event):void { gotoAndPlay(currentFrame); });
    }
  }

  // From frame 2's script, forward to 8 stopped, and its kid to 3.
  public class Nested extends MovieClip {
    public var kid:MovieClip;
    public var mid:MovieClip;

    public function Nested() {
      addFrameScript(1, function():void {
        gotoAndStop(8);
        kid.gotoAndPlay(3);
      });
    }
  }

  public class Pooled extends MovieClip {
    public var kid:MovieClip;
    public var mid:MovieClip;
  }

  public class Main extends MovieClip {
    public var forward:Forward;
    public var forwardStop:ForwardStop;
    public var back:Back;
    public var listener:Listener;
    public var forwardPlay:ForwardPlay;
    public var stopper:Stopper;
    public var same:Same;
    public var nested:Nested;
    public var pooled:Pooled;
    public var plain:MovieClip;
    public var loose:MovieClip;
    private var n:int = 0;

    public function Main() {
      addEventListener(Event.ENTER_FRAME, function(_:Event):void {
        n++;
        trace("enter " + n, where());
        if (n == 2) {
          removeChild(pooled);
          pooled.gotoAndStop(5);
        } else if (n == 5) {
          addChild(pooled);
        }
      });
      addEventListener(Event.EXIT_FRAME, function(_:Event):void {
        trace("exit  " + n, where());
      });
    }

    private function where():String {
      var out:Array = [];
      for each (var name:String in ["forward", "forwardStop", "forwardPlay", "stopper", "back", "listener", "plain", "same", "nested", "pooled"]) {
        var body:MovieClip = this[name] as MovieClip;
        if (!body) {
          out.push(name + " -");
          continue;
        }

        var mid:MovieClip = MovieClip(body.getChildByName("mid"));
        out.push(name + " " + body.currentFrame + "/" + MovieClip(body.getChildByName("kid")).currentFrame
          + "/" + MovieClip(mid.getChildByName("kid")).currentFrame);
      }

      out.push("loose " + (loose ? loose.currentFrame : "-"));
      return out.join(", ");
    }
  }
}
