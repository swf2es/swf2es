// More of what a with scope has, as findWithProperty searches it, case by
// case: attribute names, which no traits bind; nested scopes, where an
// outer one has what the inner lacks; a Proxy, asked after its traits;
// and objects whose prototype is a class's own prototype object.
import flash.utils.Proxy;
import flash.utils.flash_proxy;

function attempt(f:Function):void {
  try {
    trace(f());
  } catch (e:Error) {
    trace("error", e.errorID);
  }
}

// Attributes in a filter. An item that lacks one has no scope that has
// it, so the strict lookup throws, where attribute() gives "".
var items:XML = <list><item name="a"/><item/><item name="b" kind="k"/></list>;
var named:XML = <list><item name="a"/><item name="b" kind="k"/></list>;
attempt(function():* { return items.item.(@name == "b").length(); });
attempt(function():* { return items.item.(@kind == "k").@name; });
attempt(function():* { return named.item.(@name == "b").length(); });
attempt(function():* { return named.item.(@name == "b").@kind; });
attempt(function():* { return named.item.(@missing == "x").length(); });
attempt(function():* { return items.item.(attribute("name") == "a").length(); });

// An attribute only the outer XML has: the inner, whose traits have a
// name method, is not where @name is found.
var outer:XML = <outer name="outer-name"><inner/></outer>;
var inner:XML = outer.inner[0];
with (outer) {
  with (inner) {
    trace(@name);
    trace(name());
  }
}

// A plain name only the outer object has.
var first:Object = { shared: "outer", own: "first" };
var second:Object = { own: "second" };
with (first) {
  with (second) {
    trace(shared, own);
  }
}

// A name the inner XML has as a child, and the outer as a property.
var holder:Object = { child: "holder" };
var parent:XML = <p><child>xml</child></p>;
with (holder) {
  with (parent) {
    trace(child);
  }
}

class Logged extends Proxy {
  override flash_proxy function hasProperty(name:*):Boolean {
    trace("hasProperty", name);
    return String(name) == "here";
  }

  override flash_proxy function getProperty(name:*):* {
    return "got " + name;
  }

  override flash_proxy function callProperty(name:*, ...rest):* {
    return "called " + name;
  }

  public function method():String {
    return "method";
  }
}

var proxy:Logged = new Logged();
var around:Object = {
  here: "around here",
  there: "around there",
  toString: function():String { return "around"; }
};
with (around) {
  with (proxy) {
    trace(here);
    trace(there);
    trace(method());
    trace(toString());
  }
}

// Objects whose prototype is a class's prototype object. (Not length:
// avmshell reads an Array.prototype delegate's length, a getproperty
// matter, not a with scope's.)
function ViaRegExp():void {}
ViaRegExp.prototype = RegExp.prototype;
function ViaDate():void {}
ViaDate.prototype = Date.prototype;
function ViaArray():void {}
ViaArray.prototype = Array.prototype;
var lookups:Array = ["source", "global", "exec", "test", "getTime", "valueOf", "push", "join", "toString", "hasOwnProperty", "nothing"];
for each (var made:Object in [new ViaRegExp(), new ViaDate(), new ViaArray()]) {
  var found:Array = [];
  with (made) {
    for each (var n:String in lookups) {
      // A with scope that has the name is what findproperty gives.
      var w:* = null;
      switch (n) {
        case "source": try { w = typeof source; } catch (e:Error) { w = "E" + e.errorID; } break;
        case "global": try { w = typeof global; } catch (e:Error) { w = "E" + e.errorID; } break;
        case "exec": try { w = typeof exec; } catch (e:Error) { w = "E" + e.errorID; } break;
        case "test": try { w = typeof test; } catch (e:Error) { w = "E" + e.errorID; } break;
        case "getTime": try { w = typeof getTime; } catch (e:Error) { w = "E" + e.errorID; } break;
        case "valueOf": try { w = typeof valueOf; } catch (e:Error) { w = "E" + e.errorID; } break;
        case "push": try { w = typeof push; } catch (e:Error) { w = "E" + e.errorID; } break;
        case "join": try { w = typeof join; } catch (e:Error) { w = "E" + e.errorID; } break;
        case "toString": try { w = typeof toString; } catch (e:Error) { w = "E" + e.errorID; } break;
        case "hasOwnProperty": try { w = typeof hasOwnProperty; } catch (e:Error) { w = "E" + e.errorID; } break;
        case "nothing": try { w = typeof nothing; } catch (e:Error) { w = "E" + e.errorID; } break;
      }
      found.push(n + ":" + w);
    }
  }
  trace(found.join(" "));
}
