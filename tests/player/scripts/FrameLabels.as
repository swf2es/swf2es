// A root with FrameLabel tags and no scene data: its one scene, its labels.
package {
  import flash.display.FrameLabel;
  import flash.display.MovieClip;
  import flash.display.Scene;
  import flash.events.Event;

  public class Main extends MovieClip {
    private var step:int = 0;

    public function Main() {
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private static function labels(list:Array):String {
      var out:Array = [];
      for each (var l:FrameLabel in list) {
        out.push(l.name + "@" + l.frame);
      }

      return out.join(",");
    }

    private function frame(e:Event):void {
      step++;
      var s:Scene = currentScene;
      trace("step " + step, currentFrame, scenes.length, s.name, s.numFrames, labels(s.labels),
        currentLabel, currentFrameLabel);
      if (step == 1) {
        gotoAndPlay("b");
      } else if (step == 2) {
        try {
          gotoAndPlay("nope");
          trace("nope ok", currentFrame);
        } catch (e3:Error) {
          trace("nope threw", e3.errorID);
        }
      } else if (step == 3) {
        try {
          gotoAndStop(1, "Scene 1");
          trace("Scene 1 ok", currentFrame);
        } catch (e2:Error) {
          trace("threw", e2.errorID);
        }

        removeEventListener(Event.ENTER_FRAME, frame);
      }
    }
  }
}
