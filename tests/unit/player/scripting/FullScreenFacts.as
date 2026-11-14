package {
  import flash.display.Sprite;
  import flash.display.StageDisplayState;
  import flash.events.Event;
  import flash.events.FullScreenEvent;
  import flash.geom.Rectangle;

  public class FullScreenFacts extends Sprite {
    private var frame:int = 0;

    public function FullScreenFacts() {
      trace("initial", state(), stage.allowsFullScreen, stage.allowsFullScreenInteractive);
      stage.addEventListener(FullScreenEvent.FULL_SCREEN, function(e:FullScreenEvent):void {
        trace("  event", e.type, e.fullScreen, e.interactive, e.bubbles, e.cancelable, e.target == stage, state());
      });
      stage.addEventListener(Event.RESIZE, function(e:Event):void {
        trace("  resize", state());
      });
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function state():String {
      return stage.displayState + " " + stage.stageWidth + "x" + stage.stageHeight + " " + stage.fullScreenSourceRect;
    }

    private function attempt(label:String, f:Function):void {
      trace(label);
      try {
        f();
      } catch (e:Error) {
        trace("  thrown", e.name, e.errorID);
      }
      trace("  after", state());
    }

    private function step(e:Event):void {
      switch (++frame) {
        case 2:
          attempt("fullScreen", function():void { stage.displayState = StageDisplayState.FULL_SCREEN; });
          break;
        case 3:
          attempt("fullScreen again", function():void { stage.displayState = "fullScreen"; });
          attempt("to interactive", function():void { stage.displayState = "fullScreenInteractive"; });
          attempt("to fullScreen", function():void { stage.displayState = "fullScreen"; });
          break;
        case 4:
          attempt("bogus", function():void { stage.displayState = "bogus"; });
          attempt("null", function():void { stage.displayState = null; });
          attempt("NORMAL", function():void { stage.displayState = "NORMAL"; });
          break;
        case 5:
          attempt("source rect", function():void {
            var set:Rectangle = new Rectangle(10, 20, 300, 200);
            stage.fullScreenSourceRect = set;
            set.width = 7;
            var got:Rectangle = stage.fullScreenSourceRect;
            got.width = 5;
            trace("  copies", got === stage.fullScreenSourceRect, set === stage.fullScreenSourceRect);
          });
          attempt("mouseLock", function():void { stage.mouseLock = true; trace("  mouseLock", stage.mouseLock); });
          break;
        case 6:
          attempt("normal", function():void { stage.displayState = StageDisplayState.NORMAL; trace("  mouseLock", stage.mouseLock); });
          attempt("mouseLock in normal", function():void { stage.mouseLock = true; });
          attempt("mouseLock off in normal", function():void { stage.mouseLock = false; });
          attempt("normal again", function():void { stage.displayState = "normal"; });
          break;
        case 7:
          attempt("as the application", function():void {
            stage.fullScreenSourceRect = new Rectangle(0, 0, 960, 550);
            stage.displayState = StageDisplayState.FULL_SCREEN_INTERACTIVE;
          });
          break;
        case 8:
          attempt("window restore", function():void { stage.nativeWindow.restore(); });
          attempt("in and out", function():void { stage.displayState = "fullScreen"; stage.displayState = "normal"; });
          attempt("no rect", function():void { stage.fullScreenSourceRect = null; });
          break;
        case 9:
          attempt("noScale", function():void { stage.scaleMode = "noScale"; });
          attempt("fullScreen in noScale", function():void { stage.displayState = "fullScreen"; });
          break;
        case 10:
          attempt("rect in noScale", function():void { stage.fullScreenSourceRect = new Rectangle(0, 0, 400, 200); });
          attempt("no rect in noScale", function():void { stage.fullScreenSourceRect = null; });
          attempt("rect in noScale again", function():void { stage.fullScreenSourceRect = new Rectangle(0, 0, 400, 200); });
          break;
        case 11:
          attempt("normal in noScale", function():void { stage.displayState = "normal"; });
          break;
        case 12:
          attempt("fullScreen in noScale with the rect", function():void { stage.displayState = "fullScreen"; });
          break;
        case 13:
          attempt("normal", function():void { stage.displayState = "normal"; });
          trace("done");
          break;
      }
    }
  }
}
