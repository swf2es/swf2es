// A class declared before the interfaces it implements, in one script:
// its class is made first, and its interfaces are its all the same, and
// its subclasses', for is, as and a coercion to them.
package {
  public class Impl implements Later, Middle {
    public function f():String { return "f"; }
    public function g():String { return "g"; }
  }
  public class Sub extends Impl {}
  public interface Later {
    function f():String;
  }
  public interface Middle extends Base {
    function g():String;
  }
  public interface Base {}
}
var i:Impl = new Impl();
var s:Sub = new Sub();
trace(i is Later, i is Middle, i is Base, s is Later, s is Middle, s is Base);
trace((i as Later) != null, (s as Base) != null, Later(s).f(), Middle(i).g());
var o:Object = {};
trace(o is Later, o as Middle);
