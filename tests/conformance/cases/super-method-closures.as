// A base's method taken through super as a value, after the object's own
// override was taken as one: two closures, each calling its own method,
// as a constructor that applies this.f and an override that applies
// super.f have it; o.f stays the same closure each time, and so does
// super.f, and neither is the other.
package {
  public class Shape {
    public var count:int = 0;

    public function Shape(values:Array = null) {
      add.apply(this, values);
    }

    public function add(...values):String {
      count += values.length;
      return "shape " + values.length;
    }

    public function own():Function {
      return add;
    }
  }
}

class Frozen extends Shape {
  private var frozen:Boolean = false;

  public function Frozen(values:Array) {
    super(values);
    frozen = true;
  }

  override public function add(...values):String {
    if (frozen) {
      return "frozen";
    }

    return "frozen>" + super.add.apply(this, values);
  }

  public function sameSuper():Boolean {
    return super.add === super.add;
  }

  public function superIsOwn():Boolean {
    return super.add === add;
  }

  public function callSuper(...values):String {
    var f:Function = super.add;
    return f.apply(this, values) + " " + f.length;
  }

  public function superOfOther(other:Frozen):String {
    return super.add.call(other, 1);
  }
}

var f:Frozen = new Frozen([1, 2, 3]);
trace("count", f.count);
trace("own", f.add(4));
trace("same own", f.add === f.add, f.own() === f.add);
trace("same super", f.sameSuper());
trace("super is own", f.superIsOwn());
trace("call super", f.callSuper(5, 6));
trace("count", f.count);
var other:Frozen = new Frozen([]);
trace("super of other", f.superOfOther(other), other.count, f.count);
var s:Shape = new Shape([7]);
trace("shape", s.count, s.add(8), s.count);
