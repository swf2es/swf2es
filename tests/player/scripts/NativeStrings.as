// The natives' String parameters given an object, by what Flash traces:
// each converts it as AS3 does, an XMLList to its text and any other
// object by its toString, as a game naming its items after XML attributes
// does. Each call goes through an untyped reference, as the game's do, so
// the compiler converts nothing first: a name, a child found by name, an
// event's type and a listener's, and a request's URL and method. An Object
// parameter given undefined takes null. Then null and undefined, which a
// String parameter takes as null: refused with TypeError 2007, but by a
// request's URL.
package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.net.URLRequest;

  public class NativeStrings extends Sprite {
    public function NativeStrings() {
      var xml:XML = <item Name="Gem_Red" Kind="gem"/>;
      var named:Object = { toString: function():String { return "custom"; } };
      var self:* = this;

      var child:* = new Sprite();
      child.name = xml.attribute("Name");
      trace("name from XMLList", child.name);
      addChild(child);
      trace("found by XMLList", self.getChildByName(xml.@Name) == child);
      child.name = named;
      trace("name from object", child.name);
      trace("found by object", self.getChildByName(named) == child);
      child.name = xml.@Missing;
      trace("name from empty XMLList", "[" + child.name + "]");

      var E:Class = Event;
      var e:* = new E(xml.@Kind);
      trace("event type", e.type);
      var heard:int = 0;
      self.addEventListener(named, function (e:Event):void { heard++; });
      trace("has listener", self.hasEventListener("custom"), self.willTrigger(named));
      dispatchEvent(new Event("custom"));
      trace("heard", heard);

      var r:* = new URLRequest();
      r.url = xml.@Name;
      trace("url", r.url);
      r.method = <m>POST</m>;
      trace("method", r.method);

      // An Object parameter takes undefined as null too.
      var shape:* = new Sprite();
      shape.opaqueBackground = 0xff0000;
      shape.opaqueBackground = undefined;
      trace("opaqueBackground undefined", shape.opaqueBackground === null, shape.opaqueBackground);
      shape.focusRect = undefined;
      trace("focusRect undefined", shape.focusRect === null, shape.focusRect);

      // null and undefined, which a String parameter takes as null.
      for each (var v:* in [null, undefined]) {
        var label:String = v === null ? "null" : "undefined";
        probe(label + " name", function ():* { child.name = v; return child.name; });
        probe(label + " getChildByName", function ():* { return self.getChildByName(v); });
        probe(label + " hasEventListener", function ():* { return self.hasEventListener(v); });
        probe(label + " willTrigger", function ():* { return self.willTrigger(v); });
        probe(label + " addEventListener", function ():* { self.addEventListener(v, listener); return self.hasEventListener("null"); });
        probe(label + " removeEventListener", function ():* { self.removeEventListener(v, listener); return "done"; });
        probe(label + " Event", function ():* { return new E(v).type; });
        probe(label + " url", function ():* { r.url = v; return r.url; });
        probe(label + " method", function ():* { r.method = v; return r.method; });
      }
    }

    private function listener(e:Event):void {
    }

    private function probe(label:String, f:Function):void {
      try {
        trace(label, f());
      } catch (e:Error) {
        trace(label, "throws", e.message);
      }
    }
  }
}
