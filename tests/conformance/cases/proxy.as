// flash.utils.Proxy, as avmplus routes an instance's unbound names to its
// flash_proxy methods: a written name comes as a QName, in its namespace
// where it has one, a run-time name as the value it was; calls bring the
// QName and the arguments; in and delete and for-in go through hasProperty,
// deleteProperty and the nextName trio; a bound name never reaches them.
package {
  public namespace hidden = "http://example.com/hidden";
}
package {
  public class Namespaced {
    hidden var deep:Number = 7;
  }
}
package {
  import flash.utils.Proxy;
  import flash.utils.flash_proxy;
  // Forwards every name to its target as the name it was given.
  public class Forward extends Proxy {
    private var target:*;
    public function Forward(target:*) { this.target = target; }
    override flash_proxy function getProperty(name:*):* {
      return QName(name).uri + "|" + target[name];
    }
    override flash_proxy function setProperty(name:*, value:*):void {
      target[name] = value;
    }
  }
}
package {
  import flash.utils.Proxy;
  import flash.utils.flash_proxy;
  import avmplus.getQualifiedClassName;
  public dynamic class P extends Proxy {
    public var own:int = 42;
    public var store:Object = {};
    flash_proxy override function getProperty(name:*):* {
      trace("  get", getQualifiedClassName(name), name, name is QName ? QName(name).uri : "-");
      return store[String(name)];
    }
    flash_proxy override function setProperty(name:*, value:*):void {
      trace("  set", getQualifiedClassName(name), name, value);
      store[String(name)] = value;
    }
    flash_proxy override function hasProperty(name:*):Boolean {
      trace("  has", getQualifiedClassName(name), name);
      return String(name) in store;
    }
    flash_proxy override function deleteProperty(name:*):Boolean {
      trace("  delete", getQualifiedClassName(name), name);
      return delete store[String(name)];
    }
    flash_proxy override function callProperty(name:*, ...rest):* {
      trace("  call", getQualifiedClassName(name), name, rest);
      return rest.length;
    }
    flash_proxy override function nextNameIndex(index:int):int {
      return index < 2 ? index + 1 : 0;
    }
    flash_proxy override function nextName(index:int):String {
      return "k" + index;
    }
    flash_proxy override function nextValue(index:int):* {
      return index * 10;
    }
  }
}
namespace ns1 = "ns1";
var p:* = new P();
trace("own", p.own);
trace("get x", p.x);
p.x = 5;
trace("get x", p.x);
trace("bracket", p["x"]);
trace("ns", p.ns1::y);
p.ns1::y = 7;
trace("qname", p[new QName(ns1, "y")]);
trace("number", p[3]);
trace("in", "x" in p, "zz" in p);
trace("delete", delete p.x, delete p.ns1::y);
trace("call", p.m(1, 2), p.ns1::n());
trace("hasOwn", p.hasOwnProperty("own"), p.hasOwnProperty("x"));
trace("attr", p.@a);
var keys:Array = [];
for (var k:String in p) { keys.push(k); }
trace("for in", keys);
var values:Array = [];
for each (var v:* in p) { values.push(v); }
trace("for each", values);
trace("string", String(p), p + "");
// Under use namespace, a name the proxy gets still names that namespace too.
function forwarded():String {
  use namespace hidden;
  var f:Forward = new Forward(new Namespaced());
  f.deep = 8;
  return f.deep + " " + f.hidden::deep;
}
trace("forwarded", forwarded());
// The name proxy[key] hands the proxy, by what the key is, in a function,
// which avmshell compiles: a number's, whatever the number, is its string;
// a String's, "0" too, and an object's is a QName.
import flash.utils.Proxy;
import flash.utils.flash_proxy;

class Kinds extends Proxy {
  flash_proxy override function getProperty(name:*):* {
    return (name is QName ? "QName" : typeof name) + " " + name;
  }

  flash_proxy override function setProperty(name:*, value:*):void {
    trace("set", name is QName ? "QName" : typeof name, name);
  }
}

function kinds():void {
  const p:Kinds = new Kinds();
  const i:int = 0, n:int = -1, u:uint = 4294967295, h:Number = 1.5, nan:Number = NaN;
  const s:String = "0", t:String = "x";
  const o:Object = {toString: function():String { return "1"; }};
  trace("kinds", p[i], "|", p[n], "|", p[u], "|", p[h], "|", p[nan]);
  trace("kinds", p[s], "|", p[t], "|", p[o], "|", p[true], "|", p[null]);
  p[i] = 1;
  p[n] = 1;
  p[u] = 1;
  p[h] = 1;
  p[s] = 1;
  p[o] = 1;
}

kinds();
