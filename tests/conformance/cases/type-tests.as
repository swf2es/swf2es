// `is` and `as` against a class held in a value, as a scene graph's walk
// asks of each node: classes, their bases and siblings, interfaces through
// a base, primitives, and what is no class at all; null kept by coercions
// to class, interface, String and Object types; and `new` of a name bound
// to a slot, which holds a class, a function, or nothing.
interface IShape {}
interface IGroup extends IShape {}

class Node {
  public var next:Node;
  public var name:String;
  public function Node(name:String) { this.name = name; }
}

class Leaf extends Node {
  public function Leaf(name:String) { super(name); }
}

class Group extends Node implements IGroup {
  public var first:Node;
  public function Group(name:String) { super(name); }

  public function add(n:Node):void {
    n.next = first;
    first = n;
  }

  public function contains(n:Node):Boolean {
    if (n == this) {
      return true;
    }

    for (var c:Node = first; c != null; c = c.next) {
      if (c is Group) {
        if ((c as Group).contains(n)) {
          return true;
        }
      } else if (c == n) {
        return true;
      }
    }

    return false;
  }
}

class Special extends Group {
  public function Special(name:String) { super(name); }
}

class Holder {
  public var cls:Class = Leaf;
  public var star:* = null;
}

function probe(what:String, f:Function):void {
  try {
    trace(what, f());
  } catch (e:Error) {
    trace(what, "threw", e.errorID);
  }
}

var root:Group = new Group("root");
var inner:Special = new Special("inner");
var a:Leaf = new Leaf("a");
var b:Leaf = new Leaf("b");
var stray:Leaf = new Leaf("stray");
root.add(a);
root.add(inner);
inner.add(b);
root.add(new Leaf("c"));
trace("contains", root.contains(a), root.contains(b), root.contains(stray), root.contains(root));

var values:Array = [a, inner, root, stray, null, undefined, 1, 1.5, -1, "s", true, {}, [], new Namespace("u")];
var classes:Array = [Node, Leaf, Group, Special, IShape, IGroup, Object, Number, int, uint, String, Boolean, Array, Holder];
for (var i:int = 0; i < classes.length; i++) {
  var row:Array = [];
  for (var j:int = 0; j < values.length; j++) {
    var v:* = values[j];
    var c:* = classes[i];
    row.push((v is c ? "t" : "f") + ((v as c) === v ? "=" : (v as c) === null ? "n" : "?"));
  }
  trace(classes[i], row.join(" "));
}

var notClasses:Array = [null, undefined, 1, "Leaf", {}, new Namespace("u"), function():void {}];
for (var k:int = 0; k < notClasses.length; k++) {
  var nc:* = notClasses[k];
  probe("is " + k, function():* { return a is nc; });
  probe("as " + k, function():* { return a as nc; });
  probe("null is " + k, function():* { return null is nc; });
}

function nulls():String {
  var n:Node = null;
  var s:String = null;
  var o:Object = null;
  var f:IShape = null;
  var u:Node = undefined;
  var us:String = undefined;
  var uo:Object = undefined;
  return [n, s, o, f, u, us, uo].join(",") + " " + (n === null) + (s === null) + (o === null) + (f === null) + (u === null) + (us === null) + (uo === null);
}
trace("nulls", nulls());

var leafClass:Class = Leaf;
var nothing:* = null;
var fn:Function = function():void { this.made = "fn"; };
var holder:Holder = new Holder();
var noHolder:Holder = null;
probe("new script class", function():* { return new Group("g").name; });
probe("new class var", function():* { return new leafClass("v").name; });
probe("new null var", function():* { return new nothing(); });
probe("new function var", function():* { return new fn().made; });
probe("new holder class", function():* { return new holder.cls("h").name; });
probe("new holder null", function():* { return new holder.star(); });
probe("new on null holder", function():* { return new noHolder.cls("x"); });
probe("new on null holder args", function():* { var seen:String = "none"; try { new noHolder.cls(seen = "evaluated"); } catch (e:Error) { return seen + " " + e.errorID; } return "none"; });
probe("new builtin", function():* { return new Array(3).length; });
