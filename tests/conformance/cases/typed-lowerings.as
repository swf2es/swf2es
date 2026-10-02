// What the emitter writes in less code once the verifier's types allow
// it: each section for one such lowering, run as avmshell runs it.
package {
  public class Base {
    public var name:String;
    public function Base(name:String) { this.name = name; }
    public function who():String { return "base " + name; }
    public function get size():int { return name.length; }
  }
}
package {
  public interface Named { function label():String; }
}
package {
  public class Derived extends Base implements Named {
    public function Derived(name:String) { super(name); }
    public function label():String { return "label " + name; }
  }
}

// Coercions to a class the value's own extends or implements.
function asBase(b:Base):String { return b == null ? "null base" : b.who(); }
function asNamed(n:Named):String { return n == null ? "null named" : n.label(); }

var d:Derived = new Derived("d");
trace(d.who(), d.size, asBase(d), asNamed(d));
var none:Derived = null;
trace(asBase(none), asNamed(none));
try {
  trace(none.who());
} catch (e:Error) {
  trace("call on null", e.errorID);
}

// Constants: negative ones under negation and subtraction, -0, NaN, and
// the same constant used on both sides of a branch.
var i:int = 5;
var n:Number = 2.5;
trace(i - -3, -(-7), i * -1, n - -0.5, 1 / -0, 1 / (0 * -1), -NaN);
trace(i > 3 ? -1 : 1, i < 3 ? 100 : -100, i >>> 1, -1 >>> 28, 0xffffffff, -2147483648);
var u:uint = 4294967295;
trace(u + 1, u >> 1, u >>> 1, u & -1);
var picked:String = i > 0 ? "pos" : "neg";
trace(picked, i == 5, i === 5, n != 2.5, null == undefined);

// Additions: strings with ints, uints, Booleans, null Strings and Numbers.
var s:String = "s";
var ns:String = null;
var b:Boolean = true;
trace(s + i, i + s, s + u, s + b, b + s, s + ns, ns + s, ns + i, ns + b, ns + ns);
trace("Loading " + int(37.9) + "%", s + n, s + 1e21, s + 0.1, s + -0, s + (-i));
trace(ns + n, b + i, b + b, s + s + i + u + b);

