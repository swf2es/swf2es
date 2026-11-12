// Untyped gets, sets and calls of one name on more classes than swf2es
// caches a name's lookups for in the name's own cache, so that it keeps the
// rest on each class (property-cache.ts): slots of different types,
// accessors, methods, constants, a name in another namespace, a dynamic
// class without it, and names a sealed class's prototype has, found until
// the prototype loses them.
namespace other = "urn:other";

class S0 {
  public var x:Number = 1;
}
class S1 extends S0 {}
class S2 extends S0 {}
class S3 extends S0 {}
class S4 extends S0 {}
class S5 extends S0 {}
class S6 extends S0 {}
class S7 extends S0 {}
class S8 extends S0 {}
class S9 extends S0 {}
class S10 extends S0 {}
class S11 extends S0 {}
class S12 extends S0 {}
class S13 extends S0 {}
class S14 extends S0 {}
class S15 extends S0 {}
class S16 extends S0 {}
class S17 extends S0 {}
class S18 extends S0 {}
class S19 extends S0 {}
class S20 extends S0 {}
class S21 extends S0 {}
class S22 extends S0 {}
class S23 extends S0 {}
class S24 extends S0 {}
class S25 extends S0 {}
class Slot {
  public var a:String = "a";
  public var x:int = 2;
}
class Accessor {
  private var v_:Number = 3;
  public function get x():Number { return v_; }
  public function set x(n:Number):void { v_ = n; }
}
class Method {
  public function x():String { return "method"; }
}
class Constant {
  public const x:String = "constant";
}
class Other {
  other var x:String = "other";
}
dynamic class Dynamic {
}
class Sealed {
  public var m:int = 5;
}

function get(o:*):String {
  try {
    return String(o.x);
  } catch (e:Error) {
    return e.name + " " + e.errorID;
  }

  return "";
}

function set(o:*, v:*):String {
  try {
    o.x = v;
    return get(o);
  } catch (e:Error) {
    return e.name + " " + e.errorID;
  }

  return "";
}

function call(o:*):String {
  try {
    return String(o.x());
  } catch (e:Error) {
    return e.name + " " + e.errorID;
  }

  return "";
}

var many:Array = [
  new S0(), new S1(), new S2(), new S3(), new S4(),
  new S5(), new S6(), new S7(), new S8(), new S9(),
  new S10(), new S11(), new S12(), new S13(), new S14(),
  new S15(), new S16(), new S17(), new S18(), new S19(),
  new S20(), new S21(), new S22(), new S23(), new S24(),
  new S25()
];
var sum:Number = 0;
for (var i:int = 0; i < many.length; i++) {
  sum += many[i].x;
}

trace("many", sum);

var slot:Slot = new Slot();
var accessor:Accessor = new Accessor();
var constant:Constant = new Constant();
var dyn:Dynamic = new Dynamic();
for (var round:int = 0; round < 3; round++) {
  trace("round", round, get(slot), get(accessor), call(new Method()), get(constant));
  trace("missing", get(new Other()), get(dyn));
  trace("set", set(slot, "7.5"), set(accessor, "1.25"), set(constant, "c"));
  trace("set missing", set(new Other(), 1), set(new Method(), 1));
  trace("again", get(many[25]), get(new S0()), set(many[3], "4.5"));
}

dyn.x = "own";
trace("dynamic own", get(dyn), call(dyn));
delete dyn.x;
trace("dynamic deleted", get(dyn));

// A sealed class's prototype, given a function and a value.
var sealed:* = new Sealed();
Sealed.prototype.x = function():String { return "prototype's function"; };
for (round = 0; round < 3; round++) {
  trace("prototype", call(sealed), typeof sealed.x, set(sealed, 1));
}

Sealed.prototype.x = "prototype's value";
trace("prototype value", get(sealed), call(sealed));
delete Sealed.prototype.x;
for (round = 0; round < 2; round++) {
  trace("prototype deleted", get(sealed), call(sealed), set(sealed, 1));
}

Object.prototype.x = "Object's";
trace("Object.prototype", get(sealed), get(dyn), get(new Other()), get(slot));
delete Object.prototype.x;
trace("Object.prototype deleted", get(sealed), get(dyn));
