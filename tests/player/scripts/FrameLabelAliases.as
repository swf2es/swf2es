package {
  import flash.display.FrameLabel;
  import flash.display.MovieClip;

  public class Main extends MovieClip {
    public function Main() {
      stop();
      trace("labels", currentLabels.length);
      for each (var label:FrameLabel in currentLabels) {
        trace(label.name, label.frame);
      }

      trace("initial", currentLabel, currentFrameLabel);
      gotoAndStop("first");
      trace("first", currentFrame, currentLabel, currentFrameLabel);
      gotoAndStop(1);
      gotoAndStop("second");
      trace("second", currentFrame, currentLabel, currentFrameLabel);
      gotoAndStop(1);
      gotoAndStop("repeat");
      trace("repeat", currentFrame, currentLabel, currentFrameLabel);
    }
  }
}
