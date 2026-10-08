package {
  import flash.display.Sprite;
  import flash.display.StageAlign;
  import flash.display.StageScaleMode;
  import flash.events.Event;
  import flash.events.MouseEvent;
  import flash.events.TouchEvent;
  import flash.external.ExternalInterface;
  import flash.system.Capabilities;
  import flash.system.System;
  import flash.ui.Multitouch;

  // The web test's touch SWF: a box "a" holding a box "b", and a box "c"
  // beside it, logging the mouse and touch events the stage hears, and the
  // roll events each box hears, for the page to read. A tap writes the
  // clipboard, a touch's move tries to.
  public class TouchTest extends Sprite {
    private var log:Array = [];

    private function box(name:String, color:uint, x:Number, y:Number, size:Number):Sprite {
      var s:Sprite = new Sprite();
      s.name = name;
      s.graphics.beginFill(color);
      s.graphics.drawRect(0, 0, size, size);
      s.x = x;
      s.y = y;
      return s;
    }

    private function nameOf(o:Object):String {
      return o == null ? "null" : o == stage ? "stage" : o.name;
    }

    private function heard(e:Event):void {
      var line:String = e.type + " " + nameOf(e.target);
      if (e is TouchEvent) {
        var t:TouchEvent = TouchEvent(e);
        line += " " + (t.isPrimaryTouchPoint ? "primary" : "secondary") + " " + t.localX + "," + t.localY + " " + t.stageX + "," + t.stageY + " " + nameOf(t.relatedObject);
      } else {
        var m:MouseEvent = MouseEvent(e);
        line += " " + m.localX + "," + m.localY + " " + m.buttonDown + " " + nameOf(m.relatedObject);
      }

      log.push(line);
    }

    public function TouchTest() {
      stage.scaleMode = StageScaleMode.NO_SCALE;
      stage.align = StageAlign.TOP_LEFT;
      var a:Sprite = box("a", 0xff0000, 0, 0, 80);
      var b:Sprite = box("b", 0x0000ff, 20, 20, 40);
      a.addChild(b);
      addChild(a);
      var c:Sprite = box("c", 0x00ff00, 100, 0, 80);
      addChild(c);

      var ids:Object = {};
      var types:Array = [
        MouseEvent.MOUSE_DOWN, MouseEvent.MOUSE_UP, MouseEvent.CLICK, MouseEvent.MOUSE_MOVE,
        MouseEvent.MOUSE_OVER, MouseEvent.MOUSE_OUT, MouseEvent.ROLL_OVER, MouseEvent.ROLL_OUT,
        TouchEvent.TOUCH_BEGIN, TouchEvent.TOUCH_END, TouchEvent.TOUCH_MOVE, TouchEvent.TOUCH_OVER,
        TouchEvent.TOUCH_OUT, TouchEvent.TOUCH_ROLL_OVER, TouchEvent.TOUCH_ROLL_OUT, TouchEvent.TOUCH_TAP
      ];
      for each (var type:String in types) {
        if (type.indexOf("oll") >= 0) {
          a.addEventListener(type, heard);
          b.addEventListener(type, heard);
          c.addEventListener(type, heard);
        } else {
          stage.addEventListener(type, heard);
        }
      }

      stage.addEventListener(TouchEvent.TOUCH_MOVE, function (e:TouchEvent):void {
        try {
          System.setClipboard("moved");
        } catch (err:Error) {
          log.push("setClipboard in touchMove " + err.errorID);
        }
      });
      stage.addEventListener(TouchEvent.TOUCH_TAP, function (e:TouchEvent):void {
        System.setClipboard("tapped " + nameOf(e.target));
      });

      ExternalInterface.addCallback("touchState", function ():Array {
        return [Multitouch.supportsTouchEvents, Multitouch.maxTouchPoints, Multitouch.inputMode, Capabilities.touchscreenType];
      });
      ExternalInterface.addCallback("setMode", function (mode:String):String {
        Multitouch.inputMode = mode;
        return Multitouch.inputMode;
      });
      ExternalInterface.addCallback("takeLog", function ():Array {
        var taken:Array = log;
        log = [];
        return taken;
      });
    }
  }
}
