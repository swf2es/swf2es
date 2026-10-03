// Scenes and labels: the root has two scenes and labels from
// DefineSceneAndFrameLabelData, FrameLabel tags alike, and a FrameLabel
// tag on frame 5 that the scene data does not name; a sprite has FrameLabel tags only. Each frame
// traces where the root is, then takes one step: gotos naming a scene,
// prevScene and nextScene, a label in another scene, an unknown scene.
package {
  import flash.display.FrameLabel;
  import flash.display.MovieClip;
  import flash.display.Scene;
  import flash.events.Event;

  public class Main extends MovieClip {
    public var kid:MovieClip;
    private var step:int = 0;

    public function Main() {
      trace("constructed", currentFrame, currentScene.name);
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private static function labels(list:Array):String {
      var out:Array = [];
      for each (var l:FrameLabel in list) {
        out.push(l.name + "@" + l.frame);
      }

      return out.join(",");
    }

    private static function sceneList(clip:MovieClip):String {
      var out:Array = [];
      for each (var s:Scene in clip.scenes) {
        out.push(s.name + "/" + s.numFrames + "[" + labels(s.labels) + "]");
      }

      return out.join(" ");
    }

    private function state(what:String, clip:MovieClip = null):void {
      clip ||= this;
      trace(what, clip.currentFrame, clip.totalFrames, clip.currentScene.name,
        clip.currentScene.numFrames, clip.currentLabel, clip.currentFrameLabel,
        labels(clip.currentLabels));
    }

    private function act():void {
      switch (step) {
        case 1:
          trace("root scenes", sceneList(this));
          trace("kid scenes", sceneList(kid));
          state("kid", kid);
          trace("same scene", currentScene == currentScene, scenes == scenes);
          break;
        case 3:
          gotoAndStop(2, "Main");
          state("gotoAndStop(2, Main)");
          break;
        case 4:
          prevScene();
          state("prevScene");
          break;
        case 5:
          nextScene();
          state("nextScene");
          break;
        case 6:
          gotoAndStop(1);
          state("gotoAndStop(1)");
          break;
        case 7:
          gotoAndStop("go", "Main");
          state("gotoAndStop(go, Main)");
          break;
        case 8:
          gotoAndStop("fl_a");
          state("gotoAndStop(fl_a)");
          break;
        case 9:
          gotoAndPlay("start", "Intro");
          state("gotoAndPlay(start, Intro)");
          break;
        case 10:
          kid.gotoAndStop("run");
          state("kid run", kid);
          prevScene();
          state("prevScene in Intro");
          break;
        case 11:
          gotoAndStop("middle");
          state("gotoAndStop(middle) from Intro");
          break;
        case 12:
          gotoAndStop("go");
          break;
        case 13:
          gotoAndStop(1, "Nope");
          break;
        case 14:
          kid.gotoAndStop(1, "Intro");
          state("kid 1 Intro", kid);
          break;
        case 15:
          gotoAndStop(3, "Main");
          state("gotoAndStop(3, Main)");
          break;
        case 16:
          nextScene();
          state("nextScene in Main");
          break;
        case 17:
          kid.gotoAndStop("nope");
          state("kid nope", kid);
          kid.gotoAndStop(3);
          kid.gotoAndStop("2");
          state("kid 2 as a string", kid);
          break;
      }
    }

    private function frame(e:Event):void {
      step++;
      if (step > 17) {
        // Done: a trace that ends here, however many frames the run goes on for.
        removeEventListener(Event.ENTER_FRAME, frame);
        return;
      }

      state("step " + step);
      try {
        act();
      } catch (e2:Error) {
        trace("threw", e2.errorID, e2.name, e2.message);
      }
    }
  }
}
