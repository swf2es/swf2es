// `new` by name, on a class or a function held in a variable, and with as
// many arguments as the constructor takes, fewer or more: a constructor
// that changes its rest array or its arguments object changes nothing the
// caller passed, a function's returned object replaces the new one, and
// subclasses of builtins construct as their bases do.
import flash.utils.Dictionary;
import flash.utils.Proxy;
import flash.utils.ByteArray;

class Rest {
  public var got:String;
  public function Rest(a:int = 7, ...rest) {
    rest.push("pushed");
    rest[0] = "changed";
    got = a + " " + rest.length + " " + rest;
  }
}

class Args {
  public var got:String;
  public function Args(a:* = undefined, b:* = undefined) {
    arguments[0] = "changed";
    got = a + " " + b + " " + arguments.length;
  }
}

class E extends Error {
  public function E(m:String) { super(m, 42); }
}

class A extends Array {
  public function A(...rest) { super(rest.length); }
}

class D extends Dictionary {
  public function D() { super(true); }
}

dynamic class P extends Proxy {}

class B extends ByteArray {
  public function B(n:int) { length = n; }
}

function probe(what:String, f:Function):void {
  try {
    trace(what, f());
  } catch (e:Error) {
    trace(what, "threw", e.errorID);
  }
}

var x:* = 1;
var y:* = 2;
var z:* = 3;
probe("rest 0", function():* { return new Rest().got; });
probe("rest 1", function():* { return new Rest(x).got; });
probe("rest 3", function():* { return new Rest(x, y, z).got; });
probe("rest again", function():* { new Rest(x, y, z); return x + " " + y + " " + z; });
probe("args 0", function():* { return new Args().got; });
probe("args 2", function():* { return new Args(x, y).got; });
probe("args 4", function():* { return new Args(x, y, z, x).got; });

var cls:Class = Rest;
probe("class var", function():* { return new cls(x, y).got; });
var star:* = Args;
probe("star var", function():* { return new star(x).got; });

function Fn(a:*, b:*):void {
  arguments[1] = "changed";
  this.got = a + " " + b + " " + arguments.length;
}
probe("fn", function():* { return new Fn(x, y, z).got; });
probe("fn proto", function():* { Fn.prototype.p = "proto"; return new Fn().p; });
var Ret:Function = function(a:*):* { return {got: "returned " + a}; };
probe("fn returns", function():* { return new Ret(x).got; });
var Prim:Function = function():* { this.got = "kept"; return 5; };
probe("fn primitive", function():* { return new Prim().got; });
probe("fn instanceof", function():* { return new Fn() instanceof Fn; });
probe("closure", function():* { var o:* = new Rest(); var m:* = o.toString; return new m(); });
probe("not a constructor", function():* { var n:* = 5; return new n(); });
probe("null", function():* { var n:* = null; return new n(); });

probe("error", function():* { var e:E = new E("m"); return e.message + " " + e.errorID; });
probe("array", function():* { return new A(x, y, z).length; });
probe("dictionary", function():* { return new D() is Dictionary; });
probe("proxy", function():* { return new P() is Proxy; });
probe("bytearray", function():* { return new B(3).length; });
probe("class", function():* { var c:* = Class; return new c(); });
probe("class message", function():* { try { new Class(); } catch (e:TypeError) { return e.message; } return "none"; });
probe("namespace", function():* { return new Namespace("p", "u").uri; });
probe("object args", function():* { return new Object(x, y).toString(); });
