package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.GestureEvent;
  import flash.events.GesturePhase;
  import flash.events.PressAndTapGestureEvent;
  import flash.events.TouchEvent;
  import flash.events.TransformGestureEvent;
  import flash.system.Capabilities;
  import flash.ui.Multitouch;
  import flash.ui.MultitouchInputMode;
  import flash.utils.ByteArray;

  // Multitouch where the system has no touch screen, as adl and the
  // browser's Flash Player run here, and the touch and gesture events as
  // scripts make and dispatch them.
  public class TouchNatives extends Sprite {
    public function TouchNatives() {
      trace("supportsTouchEvents " + Multitouch.supportsTouchEvents);
      trace("supportsGestureEvents " + Multitouch.supportsGestureEvents);
      trace("maxTouchPoints " + Multitouch.maxTouchPoints);
      trace("supportedGestures " + Multitouch.supportedGestures);
      trace("inputMode " + Multitouch.inputMode);
      trace("touchscreenType " + Capabilities.touchscreenType);
      for each (var mode:* in [MultitouchInputMode.TOUCH_POINT, MultitouchInputMode.GESTURE, "bogus", null, MultitouchInputMode.NONE]) {
        try {
          Multitouch.inputMode = mode;
          trace("set " + mode + " -> " + Multitouch.inputMode);
        } catch (e:Error) {
          trace("set " + mode + " " + e + " -> " + Multitouch.inputMode);
        }
      }

      var fresh:TouchEvent = new TouchEvent(TouchEvent.TOUCH_BEGIN);
      trace(fresh);
      trace(fresh.clone());

      var box:Sprite = new Sprite();
      box.x = 10;
      box.y = 20;
      box.scaleX = 2;
      addChild(box);
      var inner:Sprite = new Sprite();
      inner.x = 3;
      box.addChild(inner);
      var heard:Function = function (e:Event):void {
        if (e is TouchEvent) {
          var t:TouchEvent = TouchEvent(e);
          trace("heard", e.type, e.eventPhase, t.localX, t.localY, t.stageX, t.stageY, t.touchPointID, t.isPrimaryTouchPoint, t.sizeX, t.sizeY, t.pressure);
          t.updateAfterEvent();
        } else if (e is PressAndTapGestureEvent) {
          var p:PressAndTapGestureEvent = PressAndTapGestureEvent(e);
          trace("heard", e.type, p.phase, p.localX, p.localY, p.stageX, p.stageY, p.tapLocalX, p.tapLocalY, p.tapStageX, p.tapStageY);
        } else {
          var g:GestureEvent = GestureEvent(e);
          trace("heard", e.type, g.phase, g.localX, g.localY, g.stageX, g.stageY);
          g.updateAfterEvent();
        }
      };
      box.addEventListener(TouchEvent.TOUCH_TAP, heard);
      box.addEventListener(TransformGestureEvent.GESTURE_ZOOM, heard);
      box.addEventListener(GestureEvent.GESTURE_TWO_FINGER_TAP, heard);
      box.addEventListener(PressAndTapGestureEvent.GESTURE_PRESS_AND_TAP, heard);

      var tap:TouchEvent = new TouchEvent(TouchEvent.TOUCH_TAP, true, false, 7, true, 4, 5, 6, 7, 0.5, inner, true, false, true);
      trace(tap);
      inner.dispatchEvent(tap);
      trace("after", tap.stageX, tap.stageY);
      tap.localX = Number.NaN;
      trace("NaN local", tap.stageX, tap.stageY);
      var copy:TouchEvent = TouchEvent(tap.clone());
      trace(copy, copy.relatedObject == inner);

      var zoom:TransformGestureEvent = new TransformGestureEvent(TransformGestureEvent.GESTURE_ZOOM, true, false, GesturePhase.UPDATE, 1, 2, 1.5, 1.25, 30, 4, 5);
      // Not its string: AIR's adds a velocity that the player's library lacks.
      inner.dispatchEvent(zoom);
      var zoomed:TransformGestureEvent = TransformGestureEvent(zoom.clone());
      trace(zoomed.type, zoomed.phase, zoomed.localX, zoomed.scaleX, zoomed.scaleY, zoomed.rotation, zoomed.offsetX, zoomed.offsetY);
      var two:GestureEvent = new GestureEvent(GestureEvent.GESTURE_TWO_FINGER_TAP);
      trace(two);
      box.dispatchEvent(two);
      var press:PressAndTapGestureEvent = new PressAndTapGestureEvent(PressAndTapGestureEvent.GESTURE_PRESS_AND_TAP, true, false, GesturePhase.ALL, 1, 2, 3, 4);
      trace(press);
      inner.dispatchEvent(press);
      trace(press.clone());
    }
  }
}
