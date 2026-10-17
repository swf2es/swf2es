package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.external.ExternalInterface;

  // The web test's activation SWF: logs ACTIVATE and DEACTIVATE as it and
  // a sprite off the display list hear them.
  public class ActivationTest extends Sprite {
    private var _orphan:Sprite = new Sprite();
    private var _log:Array = [];

    public function ActivationTest() {
      _orphan.name = "orphan";
      addEventListener(Event.ACTIVATE, heard);
      addEventListener(Event.DEACTIVATE, heard);
      _orphan.addEventListener(Event.ACTIVATE, heard);
      _orphan.addEventListener(Event.DEACTIVATE, heard);
      ExternalInterface.addCallback("takeLog", function ():Array {
        var taken:Array = _log;
        _log = [];
        return taken;
      });
    }

    private function heard(e:Event):void {
      _log.push(e.type + " " + Sprite(e.target).name);
    }
  }
}
