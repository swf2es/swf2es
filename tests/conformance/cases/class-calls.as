// Classes called and constructed in avmplus' odd corners: Object() makes an
// object for nothing, null or undefined and returns anything else, however
// many arguments; Vector.<T>(x) is x for a Vector of that type, reads any
// other object as an array-like (a ByteArray's bytes included), and refuses
// a primitive or null (1034); an interface cannot be constructed (1001, a
// method nothing implements); a class's static initializer may construct
// the class and call its statics.
package p { public interface PI { function f():void; } }
package {
  public interface I { function f():void; }
  public class K implements I { public function f():void {} }
  public class S {
    public static var INSTANCE:S = make(new S(null));
    public static var N:int = 7;
    public function S(prev:S) { trace("S(" + prev + ")", N); }
    private static function make(s:S):S { return s; }
  }
}
import p.PI;
import flash.utils.ByteArray;
function probe(label:String, fn:Function):void {
  try { trace(label, fn()); } catch (e:Error) { trace(label, "error", e.errorID); }
}
probe("new I", function():* { var c:* = I; return new c(); });
probe("new PI", function():* { var c:* = PI; return new c(); });
probe("I(k)", function():* { var c:* = I; return c(new K()); });
probe("I(5)", function():* { var c:* = I; return c(5); });
probe("Object()", function():* { var o:* = Object; return o(); });
probe("Object(asdf)", function():* { var o:* = Object; return o("asdf"); });
probe("Object(null)", function():* { var o:* = Object; return typeof o(null); });
probe("Object(undefined)", function():* { var o:* = Object; return typeof o(undefined); });
probe("Object(1,2)", function():* { var o:* = Object; return o(1, 2); });
var ba:ByteArray = new ByteArray();
ba.writeByte(66); ba.writeByte(246); ba.writeByte(233); ba.writeByte(121);
probe("Vi(ba)", function():* { return Vector.<int>(ba); });
probe("Vi(null)", function():* { return Vector.<int>(null); });
probe("Vi(undefined)", function():* { return Vector.<int>(undefined); });
probe("Vi({})", function():* { return Vector.<int>({}); });
probe("Vi(5)", function():* { return Vector.<int>(5); });
probe("Vi(str)", function():* { return Vector.<int>("abc"); });
probe("Vi(true)", function():* { return Vector.<int>(true); });
probe("Vi([1,3])", function():* { return Vector.<int>([1, 3]); });
probe("Vi([1,9.5])", function():* { return Vector.<int>([1, 9.5]); });
probe("Vi(Vn)", function():* { return Vector.<int>(new <Number>[1, 9.5]); });
probe("Vi(Vs)", function():* { return Vector.<int>(new <String>["1"]); });
probe("Vs(Vi)", function():* { return Vector.<String>(new <int>[1, 2]); });
probe("Vi(like)", function():* { return Vector.<int>({ length: 2, 0: 4, 1: 5 }); });
probe("Vi(like short)", function():* { return Vector.<int>({ length: 3, 0: 4 }); });
probe("Vi(Vi)", function():* { var v:Vector.<int> = new <int>[3, 4, 5]; var w:* = Vector.<int>(v); return (w === v) + " " + w; });
probe("Vo(Vi)", function():* { var v:Vector.<int> = new <int>[3]; var w:* = Vector.<Object>(v); return (w === v) + " " + w; });
probe("Vi(fn)", function():* { return Vector.<int>(function():void {}); });
probe("Vi(1,2)", function():* { var c:* = Vector.<int>; return c(1, 2); });
probe("Vi()", function():* { var c:* = Vector.<int>; return c(); });
probe("static init", function():* { return S.INSTANCE; });
