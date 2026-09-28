// Classes outside the package block, in the file's private namespace: as
// a base class, a parameter's, a result's and a variable's type, so that
// their coercions find them.
package {
  public class Visible {
    public var n:int = 1;
  }
}
class Hidden {
  public var label:String = "hidden";
  function Hidden(s:String = "hidden") { label = s; }
}
class HiddenSub extends Hidden {
  function HiddenSub() { super("sub"); }
  function copy(h:Hidden):Hidden { return new Hidden(h.label + "!"); }
}
function make(s:String):Hidden { return new Hidden(s); }
var h:Hidden = make("made");
var sub:HiddenSub = new HiddenSub();
var c:Hidden = sub.copy(h);
trace(h.label, sub.label, c.label, sub is Hidden, c is HiddenSub, Hidden(sub).label);
try { var bad:Hidden = Hidden(new Visible()); } catch (e:TypeError) { trace("coercion", e.errorID); }
