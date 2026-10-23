// Closures made in a package-level function, a method of its script's
// global object, whose own scope chain is empty: what a closure captures is
// only what the function pushed, so it finds its activation and catch scopes
// at their index, however many times the function pushed `this` first, as
// Crossbridge's generated code does.
package scopes {
  public function counter():Function {
    var n:int = 0;
    return function():int {
      return ++n;
    };
  }

  public function adder(x:int):Function {
    return function(y:int):int {
      return x + y;
    };
  }

  public function nested(a:int):Function {
    return function(b:int):Function {
      return function(c:int):int {
        return a * 100 + b * 10 + c;
      };
    };
  }

  public function caught():Function {
    try {
      throw new Error("e");
    } catch (e:Error) {
      return function():String {
        return e.message;
      };
    }

    return null;
  }

  public var global:String = "the global";

  public function globals():Function {
    var local:String = "local";
    return function():String {
      return local + " and " + global;
    };
  }
}

import scopes.*;

var c:Function = counter();
trace("counter", c(), c(), counter()());
trace("adder", adder(3)(4), adder(10)(-1));
trace("nested", nested(1)(2)(3));
trace("caught", caught()());
trace("globals", globals()());
