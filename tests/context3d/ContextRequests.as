package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.ErrorEvent;

  public class ContextRequests extends Sprite {
    public var complete:Boolean = false;
    private var events:int = 0;
    private var matched:Boolean = false;
    private var previous:Object;
    private var replaced:Boolean = false;
    private var disposedCode:int = 0;

    public function ContextRequests() {
      var slot:* = stage.stage3Ds[0];
      var other:* = stage.stage3Ds[1];
      other.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        matched = true;
        finish();
      });
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        events++;
        if (events == 1) {
          previous = slot.context3D;
          previous.enableErrorChecking = true;
          slot.requestContext3D("auto", "baseline");
        } else if (events == 2) {
          replaced = previous !== slot.context3D;
          slot.context3D.configureBackBuffer(32, 32, 0, false);
          try { previous.clear(); } catch (error:Error) { disposedCode = error.errorID; }
          finish();
        }
      });
      slot.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void { trace("contextrequests unexpected", e.errorID); });
      other.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void { trace("contextrequests unexpected", e.errorID); });
      test("matching-null", function():void { other.requestContext3DMatchingProfiles(null); });
      test("matching-empty", function():void { other.requestContext3DMatchingProfiles(Vector.<String>([])); });
      test("matching-invalid", function():void { other.requestContext3DMatchingProfiles(Vector.<String>(["bad"])); });
      test("matching-baseline", function():void { other.requestContext3DMatchingProfiles(Vector.<String>(["baseline"])); });
      test("mode-null", function():void { slot.requestContext3D(null, "baseline"); });
      test("mode-invalid", function():void { slot.requestContext3D("bad", "baseline"); });
      test("profile-null", function():void { slot.requestContext3D("auto", null); });
      test("profile-invalid", function():void { slot.requestContext3D("auto", "bad"); });
      test("first", function():void { slot.requestContext3D("auto", "baseline"); });
      test("pending", function():void { slot.requestContext3D("auto", "baseline"); });
    }

    private function test(label:String, f:Function):void {
      try { f(); trace("contextrequests", label, "accepted"); }
      catch (e:Error) { trace("contextrequests", label, e.name, e.errorID); }
    }

    private function finish():void {
      if (!matched || events != 2 || complete) { return; }
      trace("contextrequests events", events, matched, replaced, disposedCode);
      stage.stage3Ds[0].context3D.dispose(false);
      stage.stage3Ds[1].context3D.dispose(false);
      complete = true;
      trace("contextrequests complete");
    }
  }
}
