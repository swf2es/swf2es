package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.EventDispatcher;
  import flash.events.EventPhase;
  import flash.events.GestureEvent;
  import flash.events.KeyboardEvent;
  import flash.events.MouseEvent;
  import flash.events.PressAndTapGestureEvent;
  import flash.events.TouchEvent;
  import flash.utils.describeType;

  // The events' own fields as scripts see them: what describeType, for-in
  // and hasOwnProperty tell of them, their defaults, how their setters and
  // constructors coerce, clone and toString, and what dispatch leaves on
  // them: the getters a script reads, wherever the event keeps the values.
  public class EventFields extends Sprite {
    public function EventFields() {
      describe(new Event("e"));
      describe(new MouseEvent("m"));
      describe(new KeyboardEvent("k"));
      describe(new TouchEvent("t"));
      describe(new GestureEvent("g"));
      describe(new PressAndTapGestureEvent("p"));

      defaults();
      coercion();
      readOnly();
      dispatching();
      subclassed();
    }

    // Its toString as Flash Player's: AIR's, which adl runs, goes on with
    // the keys only AIR has on a mouse or a keyboard.
    private static function playerString(e:Event):String {
      return String(e).replace(/ (commandKey|controlKey)=.*\]$/, "]");
    }

    // Its accessors and variables of the fields this case is about, sorted.
    private function describe(e:Event):void {
      var x:XML = describeType(e);
      var lines:Array = [];
      for each (var a:XML in x.accessor) {
        // AIR's own, which adl shows and Flash Player hides.
        if (["commandKey", "controlKey", "clickCount", "functionKey", "timestamp", "touchIntent", "isTouchPointCanceled"].indexOf(String(a.@name)) >= 0 && String(a.@declaredBy) != "flash.events::GestureEvent") {
          continue;
        }

        lines.push("accessor " + a.@name + " " + a.@access + " " + a.@type + " " + a.@declaredBy);
      }

      for each (var v:XML in x.variable) {
        lines.push("variable " + v.@name + " " + v.@type);
      }

      lines.sort();
      trace(x.@name + " " + x.@isDynamic + " " + x.@isFinal);
      trace("  " + lines.join("\n  "));

      var keys:Array = [];
      for (var k:String in e) {
        keys.push(k);
      }

      trace("  for-in [" + keys + "]");
      for each (var name:String in ["type", "bubbles", "target", "eventPhase", "localX", "ctrlKey", "charCode"]) {
        trace("  " + name + " in " + (name in e) + " own " + e.hasOwnProperty(name) + " enumerable " + e.propertyIsEnumerable(name));
      }
    }

    private function defaults():void {
      var e:Event = new Event("plain");
      trace(e, e.target, e.currentTarget, e.eventPhase, e.isDefaultPrevented());
      e.preventDefault();
      trace("prevented uncancelable " + e.isDefaultPrevented());
      var c:Event = new Event("c", true, true);
      c.preventDefault();
      trace("prevented cancelable " + c.isDefaultPrevented() + " clone " + c.clone().isDefaultPrevented());
      c.stopPropagation();
      c.stopImmediatePropagation();
      trace(c.clone());

      var nothing:* = null;
      try {
        trace("null type " + new Event(nothing).type);
      } catch (error:Error) {
        trace("null type " + error);
      }

      var u:* = undefined;
      try {
        trace("undefined type " + new Event(u).type);
      } catch (error:Error) {
        trace("undefined type " + error);
      }

      try {
        trace("null mouse type " + new MouseEvent(nothing).type);
      } catch (error:Error) {
        trace("null mouse type " + error);
      }

      var num:* = 12;
      trace("number type " + (new Event(num).type is String) + " " + new Event(num).type);
      trace("flags " + new Event("f", nothing, "yes" as Boolean).bubbles + " " + new Event("f", 0, {}).cancelable);

      var m:MouseEvent = new MouseEvent("m");
      trace(playerString(m));
      trace(playerString(m.clone()));
      trace(m.relatedObject, m.stageX, m.stageY, m.movementX, m.isRelatedObjectInaccessible);
      trace(playerString(new MouseEvent("m2", false, true, 1.5, -2.5, null, true, true, true, true, 7, true, true, 3).clone()));

      var k:KeyboardEvent = new KeyboardEvent("k");
      trace(playerString(k));
      trace(playerString(new KeyboardEvent("k2", false, true, 65, 66, 1, true, true, true, true, true).clone()));

      var t:TouchEvent = new TouchEvent("t");
      trace(t.localX, t.localY, t.stageX, t.stageY);
      trace(new TouchEvent("t2", true, false, 4, true, 5, 6).clone());
      var g:GestureEvent = new GestureEvent("g", true, false, null, 7, 8);
      trace(g.clone());
      var p:PressAndTapGestureEvent = new PressAndTapGestureEvent("p", true, false, null, 1, 2, 3, 4);
      trace(p.tapLocalX, p.tapLocalY, p.tapStageX, p.tapStageY, p.clone());
    }

    private function coercion():void {
      var m:MouseEvent = new MouseEvent("m");
      var any:Object = m;
      any.localX = "3.5";
      any.localY = "nope";
      any.delta = 3.9;
      any.ctrlKey = "";
      any.altKey = {};
      any.shiftKey = 2;
      any.buttonDown = "false";
      trace(m.localX, m.localY, m.delta, m.ctrlKey, m.altKey, m.shiftKey, m.buttonDown);
      any.delta = -2.5;
      any.localX = undefined;
      any.localY = null;
      any.movementX = "4";
      trace(m.delta, m.localX, m.localY, m.movementX);
      any.delta = 4294967297;
      trace(m.delta);
      try {
        any.relatedObject = new Object();
      } catch (e:Error) {
        trace("relatedObject " + e.errorID);
      }

      var big:* = -1;
      var half:* = "70000.7";
      var k:KeyboardEvent = new KeyboardEvent("k", true, false, big, half, big, "x" as Boolean);
      trace(k.charCode, k.keyCode, k.keyLocation, k.ctrlKey);
      var kAny:Object = k;
      kAny.charCode = -2;
      kAny.ctrlKey = 0;
      kAny.altKey = "a";
      kAny.shiftKey = NaN;
      trace(k.charCode, k.ctrlKey, k.altKey, k.shiftKey);

      var t:TouchEvent = new TouchEvent("t", true, false, 0, false, half, big);
      trace(t.localX, t.localY);
      Object(t).localX = "8";
      trace(t.localX);
      var p:PressAndTapGestureEvent = new PressAndTapGestureEvent("p");
      Object(p).tapLocalX = "2";
      Object(p).tapLocalY = true;
      trace(p.tapLocalX, p.tapLocalY);
    }

    private function readOnly():void {
      var e:Object = new MouseEvent("m");
      for each (var name:String in ["type", "bubbles", "cancelable", "target", "currentTarget", "eventPhase", "stageX", "stageY"]) {
        try {
          e[name] = 1;
          trace(name + " written");
        } catch (error:Error) {
          trace(name + " " + error.errorID);
        }
      }

      try {
        e.unknown = 1;
      } catch (error:Error) {
        trace("unknown " + error.errorID);
      }
    }

    private function dispatching():void {
      var outer:Sprite = new Sprite();
      var inner:Sprite = new Sprite();
      outer.x = 10;
      inner.x = 5;
      inner.scaleY = 2;
      addChild(outer);
      outer.addChild(inner);

      var heard:Function = function (e:Event):void {
        var line:String = e.type + " " + e.eventPhase + " " + (e.target == inner) + " " + (e.currentTarget == outer);
        if (e is MouseEvent) {
          var m:MouseEvent = MouseEvent(e);
          line += " " + m.localX + " " + m.localY + " " + m.stageX + " " + m.stageY + " " + m.ctrlKey;
        }

        trace(line);
        if (e.type == "stop" && e.eventPhase == EventPhase.CAPTURING_PHASE) {
          e.stopPropagation();
        }

        if (e.type == "now" && e.eventPhase == EventPhase.AT_TARGET) {
          e.stopImmediatePropagation();
        }

        e.preventDefault();
      };
      var after:Function = function (e:Event):void {
        trace("after " + e.type + " " + e.eventPhase);
      };
      for each (var o:Sprite in [outer, inner]) {
        for each (var type:String in ["go", "stop", "now", MouseEvent.CLICK]) {
          o.addEventListener(type, heard, true);
          o.addEventListener(type, heard);
          o.addEventListener(type, after);
        }
      }

      var go:Event = new Event("go", true, true);
      trace("returned " + inner.dispatchEvent(go) + " " + go.isDefaultPrevented());
      trace("left " + go.eventPhase + " " + (go.target == inner) + " " + (go.currentTarget == null) + " " + (go.currentTarget == inner));
      trace("returned " + inner.dispatchEvent(new Event("stop", true, false)));
      trace("returned " + inner.dispatchEvent(new Event("now", true)));
      var click:MouseEvent = new MouseEvent(MouseEvent.CLICK, true, false, 2, 3, null, true);
      inner.dispatchEvent(click);
      trace("again " + inner.dispatchEvent(go) + " " + go.eventPhase);
      var clone:Event = click.clone();
      trace(clone.target, clone.currentTarget, clone.eventPhase, playerString(clone));

      var standIn:EventDispatcher = new EventDispatcher(inner);
      standIn.addEventListener("go", function (e:Event):void {
        trace("stand-in " + (e.target == inner) + " " + (e.currentTarget == inner) + " " + e.eventPhase);
      });
      standIn.dispatchEvent(new Event("go"));
    }

    private function subclassed():void {
      var e:Labelled = new Labelled("x", "tag");
      trace(e, e.clone(), e.label, Labelled(e.clone()).label);
      var outer:Sprite = new Sprite();
      outer.addEventListener("x", function (l:Labelled):void {
        trace("heard " + l.label + " " + l.eventPhase + " " + (l.target == outer));
      });
      outer.dispatchEvent(e);
      outer.dispatchEvent(e);
    }
  }
}

import flash.events.Event;

class Labelled extends Event {
  private var _label:String;

  public function Labelled(type:String, label:String) {
    super(type, true, true);
    _label = label;
  }

  public function get label():String {
    return _label;
  }

  override public function clone():Event {
    return new Labelled(type, _label + "'");
  }

  override public function toString():String {
    return formatToString("Labelled", "type", "label", "eventPhase");
  }
}
