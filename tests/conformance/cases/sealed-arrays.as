// A subclass of Array that is not dynamic has no elements from SWF 13:
// adding one fails as a sealed object's property does, and its length stays
// 0. A dynamic subclass of it has them again.
package {
  public class Sealed extends Array {}
}
package {
  public dynamic class Unsealed extends Sealed {}
}
import avmplus.System;
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e); }
}
trace(System.swfVersion >= 13);
var s:Sealed = new Sealed();
probe("push", function():* { return s.push(1); });
probe("push none", function():* { return s.push(); });
probe("unshift", function():* { return s.unshift(1); });
probe("splice", function():* { return s.splice(0, 0, 1); });
probe("splice none", function():* { return s.splice(0, 1).length; });
probe("pop", function():* { return s.pop(); });
probe("shift", function():* { return s.shift(); });
probe("length", function():* { s.length = 5; return s.length; });
probe("get", function():* { return s[0]; });
probe("set", function():* { s[0] = 1; });
probe("has", function():* { return s.hasOwnProperty(0) + " " + (0 in s); });
probe("delete", function():* { return delete s[0]; });
probe("methods", function():* { return [s.join("-"), s.concat([1]).length, s.indexOf(1), s.slice().length, s.reverse().length, s.sort().length].join(" "); });
var names:String = "";
for (var k:* in s) { names += k; }
probe("for-in", function():* { return names; });
var u:Unsealed = new Unsealed();
u.push(1, 2);
u[3] = 4;
trace(u.length, u.join("-"), u is Sealed);
