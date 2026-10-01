// avmplus.describeType, the XML avmplus builds from describeTypeJSON: a
// class's and an instance's description, the flags one by one, builtins,
// a Vector, a Function, void and null, metadata, and what the AS3
// namespace and an interface's namespace do. avmplus walks its bindings in
// a hashtable keyed by string addresses, so each element's children are
// sorted here, as Ruffle's tests sort them.
package {
  public interface I { function im():void; }
  public interface J extends I { function jm(x:int):String; }
  [Meta(a="1", b="2")]
  [Plain]
  public class Base implements I {
    public static const K:int = 1;
    [Slot(tag="s")]
    public var bv:Number = 2;
    public function get acc():String { return "a"; }
    [Setter]
    public function set acc(v:String):void {}
    public function im():void {}
    [M] [N(k="v")]
    public function bm(x:int, y:String = "d", ...rest):Array { return null; }
    AS3 function as3Method():void {}
  }
  public dynamic class Sub extends Base implements J {
    public static var sv:String;
    public const c:uint = 3;
    public function Sub(a:int, b:*) { super(); }
    public function sm():void {}
    public function jm(x:int):String { return ""; }
    override public function bm(x:int, y:String = "d", ...rest):Array { return null; }
  }
  public final class Fin {}
}
import avmplus.*;

function normalize(x:XML, indent:String = ""):String {
  var s:String = indent + "<" + x.name();
  for each (var a:XML in x.attributes()) {
    s += " " + a.name() + '="' + a.toString() + '"';
  }
  var kids:Array = [];
  for each (var k:XML in x.children()) {
    kids.push(normalize(k, indent + "  "));
  }
  if (kids.length == 0) {
    return s + "/>";
  }
  kids.sort();
  return s + ">\n" + kids.join("\n") + "\n" + indent + "</" + x.name() + ">";
}

function show(label:String, v:*, flags:uint):void {
  trace("--", label, flags);
  try {
    for each (var line:String in normalize(describeType(v, flags)).split("\n")) {
      trace(line);
    }
  } catch (e:Error) {
    trace("error", e.errorID);
  }
}

show("Sub", Sub, FLASH10_FLAGS);
show("new Sub", new Sub(1, 2), FLASH10_FLAGS);
show("Base", Base, FLASH10_FLAGS);
show("new Base", new Base(), INCLUDE_TRAITS | INCLUDE_BASES | INCLUDE_METHODS | INCLUDE_ACCESSORS | INCLUDE_VARIABLES);
show("new Base no metadata", new Base(), FLASH10_FLAGS & ~INCLUDE_METADATA);
show("I", I, FLASH10_FLAGS);
show("J", J, FLASH10_FLAGS);
show("Fin", Fin, FLASH10_FLAGS);
show("int", int, FLASH10_FLAGS);
show("5", 5, FLASH10_FLAGS);
show("1 << 28", 1 << 28, INCLUDE_TRAITS | INCLUDE_BASES);
show("-(1 << 28)", -(1 << 28), INCLUDE_TRAITS | INCLUDE_BASES);
show("1.5", 1.5, INCLUDE_TRAITS | INCLUDE_BASES);
show("null", null, FLASH10_FLAGS);
show("undefined", undefined, FLASH10_FLAGS);
show("Vector.<int>", Vector.<int>, FLASH10_FLAGS);
show("Vector.<Sub>", new <Sub>[], INCLUDE_TRAITS | INCLUDE_BASES | INCLUDE_CONSTRUCTOR);
show("function", function():void {}, FLASH10_FLAGS);
show("Object", Object, FLASH10_FLAGS);
show("new Object", {}, FLASH10_FLAGS);
show("Array", [], INCLUDE_TRAITS | INCLUDE_BASES | INCLUDE_METHODS | HIDE_NSURI_METHODS);
show("String", "s", INCLUDE_TRAITS | INCLUDE_BASES | INCLUDE_ACCESSORS);
show("Sub bases only", Sub, INCLUDE_TRAITS | INCLUDE_BASES);
show("Sub traits only", Sub, INCLUDE_TRAITS | INCLUDE_BASES | INCLUDE_INTERFACES | INCLUDE_METADATA);
show("Sub no bases", Sub, INCLUDE_TRAITS | INCLUDE_METHODS);
show("Sub flags 0", Sub, 0);
show("Sub itraits", Sub, FLASH10_FLAGS | USE_ITRAITS);
show("5 itraits", 5, INCLUDE_TRAITS | INCLUDE_BASES | USE_ITRAITS);
trace(getQualifiedClassName(1 << 28), getQualifiedClassName(-(1 << 28) - 1), getQualifiedClassName(1 << 27), getQualifiedClassName(new <int>[]), getQualifiedClassName(new <Sub>[]), getQualifiedClassName(Vector.<Number>));
trace(getQualifiedSuperclassName(new Sub(1, 2)), getQualifiedSuperclassName(Sub), getQualifiedSuperclassName(Object), getQualifiedSuperclassName(5), getQualifiedSuperclassName(new <int>[]));
