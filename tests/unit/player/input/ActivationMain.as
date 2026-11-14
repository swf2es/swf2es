package {
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.EventDispatcher;
  import flash.events.KeyboardEvent;
  public class ActivationMain extends Sprite {
    private var _orphan:Sprite = new Sprite();
    private var _plain:EventDispatcher = new EventDispatcher();
    private var _ticker:Ticker = new Ticker();
    public function ActivationMain() {
      addEventListener(Event.DEACTIVATE, heard);
      addEventListener(Event.ACTIVATE, heard);
      _orphan.name = "orphan";
      _orphan.addEventListener(Event.DEACTIVATE, heard);
      _orphan.addEventListener(Event.ACTIVATE, heard);
      _plain.addEventListener(Event.DEACTIVATE, heard);
      _plain.addEventListener(Event.ACTIVATE, heard);
      stage.addEventListener(KeyboardEvent.KEY_DOWN, function(e:KeyboardEvent):void {
        trace("key", e.keyCode, "start");
        trace("key", e.keyCode, "end");
      });
    }
    private function heard(e:Event):void {
      var name:String = e.target is Sprite ? Sprite(e.target).name : "plain";
      trace(e.type, name, e.target == e.currentTarget, e.eventPhase, e.bubbles, e.cancelable);
    }
  }
  public class Ticker extends MovieClip {
    public function Ticker() {
      name = "ticker";
      addFrameScript(0, tick, 1, tick);
      addEventListener(Event.DEACTIVATE, function(e:Event):void { trace("deactivate ticker"); });
    }
    private function tick():void {
      trace("tick");
    }
  }
}
