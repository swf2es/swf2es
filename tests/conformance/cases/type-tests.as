// `is` and `as` against a class held in a value, as a scene graph's walk
// asks of each node: classes, their bases and siblings, interfaces through
// a base, primitives, and what is no class at all; null kept by coercions
// to class, interface, String and Object types; and `new` of a name bound
// to a slot, which holds a class, a function, or nothing; and classes of
// child domains, the same ABC loaded into two of them.
import avmplus.Domain;
import flash.utils.ByteArray;

// package kid's interface IKid, KidBase, which extends Error and implements
// IKid, and Kid, which extends KidBase; and a script that tests and coerces
// a Kid, a KidBase, null and undefined against them.
const KID:String =
  "10002e000000001204494b6964036b6964074b696442617365054572726f7200046e657874034b69" +
  "64016b1146696c65507269766174654e533a6b6964026e6b026e69016f016206537472696e67016d" +
  "064f626a65637405747261636504160216050509000e070101070103070204070206070107070308" +
  "07030a07030b07030c07030d07020e0702100702110700000000000000000000000001000b038801" +
  "05010f0000000001000b07880105010f000000000003010004000200020301010103000502010005" +
  "01040000050001000400060001000801040000020400010504000206000005000700000500080000" +
  "010009000000000a0000020006010001000001470000030202000107d030d0d14901470000040001" +
  "000001470000050202000107d030d0d1490147000006000100000147000000110100049d01d03065" +
  "0020580068016500600c3060032a3058011d1d68026500600c3060033060022a3058021d1d1d6805" +
  "5d052c084a05015e062b6106205e072b6107215e082b610860065e092b61095d024a02005e0a2b61" +
  "0a600d642c0260066005b360066002b360066001b360066003b36006600cb360096005876006ac60" +
  "076005b360076001876008206001b3600a6005b3600a600587600a6001b3410e29470000";

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

var values:Array = [a, inner, root, stray, null, undefined, 1, 1.5, -1, "s", true, {}, [], new Namespace("u"), Leaf, IShape, probe];
var classes:Array = [Node, Leaf, Group, Special, IShape, IGroup, Object, Number, int, uint, String, Boolean, Array, Holder, Class, Function, Namespace];
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

function bytes(hex:String):ByteArray {
  var out:ByteArray = new ByteArray();
  for (var i:int = 0; i < hex.length; i += 2) {
    out.writeByte(parseInt(hex.substr(i, 2), 16));
  }
  return out;
}

var one:Domain = new Domain(Domain.currentDomain);
var two:Domain = new Domain(Domain.currentDomain);
probe("load one", function():* { return one.loadBytes(bytes(KID)); });
probe("load two", function():* { return two.loadBytes(bytes(KID)); });
var Kid1:Class = one.getClass("kid.Kid");
var Base1:Class = one.getClass("kid.KidBase");
var IKid1:Class = one.getClass("kid.IKid");
var Kid2:Class = two.getClass("kid.Kid");
var IKid2:Class = two.getClass("kid.IKid");
var kid1:* = new Kid1("one");
var base1:* = new Base1("base");
var kids:Array = [Kid1, Base1, IKid1, Kid2, IKid2, Error, Object, Node];
for (var q:int = 0; q < kids.length; q++) {
  var kc:* = kids[q];
  trace(kc, kid1 is kc, base1 is kc, (kid1 as kc) === kid1, (base1 as kc) === base1, null is kc, a is kc);
}
