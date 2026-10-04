// Whether a goto's play or stop wins over what the frame it lands on says,
// in a SWF of version 10, whose goto runs that frame's script at once. On
// the root's frame 2 its script sends a, whose every frame stops, to play
// from 4, and c, whose frame 4 plays, to stop there; p to stop on 3 then
// step to 4; e and f, which have no scripts, past their ends; q and r,
// whose frame 2 scripts send themselves to 4 and then say the opposite;
// and t, playing, whose frame 2 script sends it to stop on 4. An
// ENTER_FRAME listener sends b, another a, to play from 4. On frame 3 a is
// sent to play again on the frame it stopped on, and r told to play. The
// root traces each clip's frame, frame by frame: whether a clip moves on
// is whether it plays (isPlaying, which Flash keeps apart, is not traced).
package {
  import flash.display.MovieClip;
  import flash.events.Event;

  public class S extends MovieClip {
    public function S() {
      for (var i:int = 0; i < 6; i++) {
        addFrameScript(i, step(i + 1));
      }
    }

    private function step(frame:int):Function {
      return function():void {
        Main.say(name + " script " + frame + ", stop");
        stop();
      };
    }
  }

  public class P extends MovieClip {
    public function P() {
      for (var i:int = 0; i < 6; i++) {
        addFrameScript(i, step(i + 1));
      }
    }

    private function step(frame:int):Function {
      return function():void {
        if (frame == 4) {
          Main.say(name + " script " + frame + ", play");
          play();
        } else {
          Main.say(name + " script " + frame + ", stop");
          stop();
        }
      };
    }
  }

  public class Q extends MovieClip {
    public function Q() {
      addFrameScript(0, function():void { stop(); },
        1, function():void {
          Main.say("q script 2, gotoAndPlay 4, stop");
          gotoAndPlay(4);
          stop();
        },
        3, function():void { Main.say("q script 4"); });
    }
  }

  public class R extends MovieClip {
    public function R() {
      addFrameScript(0, function():void { stop(); },
        1, function():void {
          Main.say("r script 2, gotoAndStop 4, play");
          gotoAndStop(4);
          play();
        },
        3, function():void { Main.say("r script 4"); });
    }
  }

  public class T extends MovieClip {
    public function T() {
      addFrameScript(0, function():void { stop(); },
        1, function():void {
          Main.say("t script 2, gotoAndStop 4");
          gotoAndStop(4);
        },
        3, function():void { Main.say("t script 4"); });
    }
  }

  public class Main extends MovieClip {
    public var a:S;
    public var b:S;
    public var c:P;
    public var p:P;
    public var q:Q;
    public var r:R;
    public var e:MovieClip;
    public var f:MovieClip;
    public var t:T;
    public static var stopped:Boolean = false;
    private var sent:Boolean = false;

    public static function say(what:String):void {
      if (!stopped) trace(what);
    }

    public function Main() {
      addEventListener(Event.ENTER_FRAME, function(_:Event):void {
        if (!sent && currentFrame == 2) {
          sent = true;
          say("listener: b.gotoAndPlay(4)");
          b.gotoAndPlay(4);
          state("listener");
        }
      });
      addFrameScript(0, function():void { state("frame 1"); },
        1, function():void {
          say("a.gotoAndPlay(4)");
          a.gotoAndPlay(4);
          say("c.gotoAndStop(4)");
          c.gotoAndStop(4);
          say("p.gotoAndStop(3), p.nextFrame()");
          p.gotoAndStop(3);
          p.nextFrame();
          say("q.gotoAndStop(2)");
          q.gotoAndStop(2);
          say("r.gotoAndStop(2)");
          r.gotoAndStop(2);
          say("t.gotoAndPlay(2)");
          t.gotoAndPlay(2);
          e.gotoAndPlay(6);
          e.nextFrame();
          f.gotoAndPlay(1);
          f.prevFrame();
          state("frame 2");
        },
        2, function():void {
          state("frame 3");
          say("a.gotoAndPlay(4) again");
          a.gotoAndPlay(4);
          say("r.play()");
          r.play();
          state("frame 3 after");
        },
        3, function():void { state("frame 4"); },
        4, function():void {
          state("frame 5");
          stopped = true;
          stop();
        });
    }

    private function state(when:String):void {
      var parts:Array = [when];
      for each (var clip:MovieClip in [a, b, c, p, q, r, e, f, t]) {
        parts.push(clip.name + "=" + clip.currentFrame);
      }
      say(parts.join(" "));
    }
  }
}
