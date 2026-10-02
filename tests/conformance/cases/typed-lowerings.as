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

