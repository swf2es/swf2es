// == and === between operands typed as classes, interfaces and class
// objects compare by identity, null and undefined alike, as AvmCore::equals
// does, and codegen writes JavaScript's own operators for them; those typed
// XML, XMLList, QName, Namespace, Object or * compare by content or convert,
// through the runtime.
interface IShape {
}

class Shape implements IShape {
  public var next:Shape;
}

class Square extends Shape {
}

class Other {
}

function same(a:Shape, b:Shape):Array {
  return [a == b, a != b, a === b, a !== b];
}

function mixed(a:Shape, b:Square, c:IShape, d:Other):Array {
  return [a == b, b == a, a == c, c == a, a == d, c == null, null == c, a == null];
}

function walk(first:Shape, wanted:Shape):int {
  var n:int = 0;
  for (var s:Shape = first; s != null; s = s.next) {
    if (s == wanted) {
      return n;
    }

    n++;
  }

  return -1;
}

function classes(a:Class, b:Class):Array {
  return [a == b, a === b, a != null];
}

function dates(a:Date, b:Date, s:String, o:Object):Array {
  return [a == b, a === b, a == s, s == a, a == o, o == a, a == null];
}

function xmls(a:XML, b:XML, l:XMLList, s:Shape):Array {
  return [a == b, a === b, a == l, l == a, a == s, a == null, l == null];
}

function names(a:QName, b:QName, n:Namespace, m:Namespace):Array {
  return [a == b, a === b, n == m, n === m, a == null, n == null];
}

function functions(f:Function, g:Function):Array {
  return [f == g, f === g, f == null];
}

function untyped(a:*, b:Object, s:Shape):Array {
  return [a == s, s == a, b == s, s == b, a == null, a === undefined];
}

function arrays(a:Array, b:Array, v:Vector.<int>, w:Vector.<int>):Array {
  return [a == b, a === b, v == w, v === w, a == null];
}

var x:Shape = new Shape();
var y:Square = new Square();
var z:Shape = new Shape();
x.next = y;
y.next = z;
trace(same(x, x), same(x, z), same(null, null), same(x, null), same(null, x));
trace(mixed(y, y, y, new Other()), mixed(x, null, null, null), mixed(null, null, null, null));
trace(walk(x, z), walk(x, y), walk(x, new Shape()), walk(null, null), walk(x, null));
trace(classes(Shape, Shape), classes(Shape, Square), classes(null, null));

var d1:Date = new Date(2000, 0, 1);
var d2:Date = new Date(2000, 0, 1);
trace(dates(d1, d2, d1.toString(), d1), dates(d1, d1, "x", d2), dates(null, null, null, null));

var a:XML = <a>1</a>;
var b:XML = <a>1</a>;
var c:XML = <b>2</b>;
trace(xmls(a, b, new XMLList(a), x), xmls(a, c, a.children(), null), xmls(null, null, null, null));
trace(names(new QName("u", "n"), new QName("u", "n"), new Namespace("p", "u"), new Namespace("q", "u")));
trace(names(new QName("u", "n"), new QName("v", "n"), new Namespace("u"), new Namespace("v")));
trace(names(null, null, null, null));

var f:Function = function():void {};
trace(functions(f, f), functions(f, function():void {}), functions(null, null));
trace(functions(x.toString, x.toString), functions(trace, trace));
trace(untyped(x, x, x), untyped(undefined, null, null), untyped(null, undefined, x), untyped("s", "s", x));

var arr:Array = [1];
var vec:Vector.<int> = new <int>[1];
trace(arrays(arr, arr, vec, vec), arrays(arr, [1], vec, new <int>[1]), arrays(null, null, null, null));
