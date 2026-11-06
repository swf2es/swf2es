// `new` of a known class whose slot is still empty, as A's static
// initializer runs before B, C and D are made: avmshell's JIT, which
// binds a constructor that takes the count, checks the slot first,
// TypeError 1009, before it coerces any argument; a count it does not
// take, and a static initializer, which avmshell interprets, construct
// late, TypeError 1007.
class A {
  public static var k:* = 3;
  public static var x:String = attempt("method", function ():* { return new B(1); });
  public static var y:String = attempt("method wrong argument", function ():* { return new C(k); });
  public static var z:String = attempt("method null argument", function ():* { return new C(null); });
  public static var w:String = attempt("method too few", function ():* { var b:* = new B(); return b; });
  public static var v:String = attempt("method default", function ():* { return new D(); });
  public static var u:String = attempt("method rest", function ():* { return new E(1, 2, 3); });
  public static var t:String = fromMethod();

  {
    try { new B(1); } catch (e:Error) { trace("static init", e.errorID); }
    try { new C(k); } catch (e:Error) { trace("static init wrong argument", e.errorID); }
    try { new D(); } catch (e:Error) { trace("static init default", e.errorID); }
  }

  public static function attempt(name:String, f:Function):String {
    try {
      trace(name, f());
    } catch (e:Error) {
      trace(name, e.errorID);
    }

    return name;
  }

  public static function fromMethod():String {
    try { new B(2); } catch (e:Error) { trace("static method", e.errorID); }
    try { new C(k); } catch (e:Error) { trace("static method wrong argument", e.errorID); }
    return "";
  }
}
class B { public function B(n:int) {} }
class C { public function C(d:D) {} }
class D { public function D(n:Number = 1) {} }
class E { public function E(n:int, ...rest) {} }
trace("after", new B(1) is B, new C(null) is C, new D() is D, new E(1, 2) is E);
