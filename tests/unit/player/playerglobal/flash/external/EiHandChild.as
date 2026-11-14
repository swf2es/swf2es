package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.external.ExternalInterface;
  public class EiHandChild extends Sprite {
    public function EiHandChild() {
      addEventListener(Event.ADDED_TO_STAGE, added);
    }

    private function added(e:Event):void {
      var main:Object = parent.parent;
      stage.addEventListener("relay", ExternalInterface.call);
      stage.addEventListener("ping", ExternalInterface.call);
      main.relayed = new EiRelay();
      main.names = ["hello"];
      main.sorts = ["hello", "there"];
      main.fn = ExternalInterface.call;
    }
  }
}

import flash.events.Event;

class EiRelay extends Event {
  public function EiRelay() {
    super("relay");
  }

  override public function toString():String {
    return "hello";
  }
}
