// A for-in goes on through an object's prototypes, whose names are mostly
// hidden: it goes through a name on one as soon as that name is shown, and
// past an object whose names are all hidden, however they came to be.
import flash.utils.Dictionary;

function names(x:*):String {
  var seen:Array = [];
  for (var k:* in x) {
    seen.push(String(k));
  }

  seen.sort();
  return seen.join(",");
}

function values(x:*):String {
  var seen:Array = [];
  for each (var v:* in x) {
    seen.push(String(v));
  }

  seen.sort();
  return seen.join(",");
}

class Sealed {
  public var a:int = 1;

  public function f():int {
    return a;
  }
}

var o:Object = {a: 1};
trace("plain", names(o), values(o));
trace("empty", names({}), "sealed", names(new Sealed()));

Object.prototype.extra = 2;
trace("prototype name", names(o), values(o), names({}), names(new Sealed()));
Object.prototype.setPropertyIsEnumerable("extra", false);
trace("prototype name hidden", names(o), names({}));
Object.prototype.setPropertyIsEnumerable("extra", true);
trace("prototype name shown", names(o), names({}));
delete Object.prototype.extra;
trace("prototype name deleted", names(o), names({}));

Sealed.prototype.shared = 3;
trace("class prototype name", names(new Sealed()), values(new Sealed()));
delete Sealed.prototype.shared;
trace("class prototype name deleted", names(new Sealed()));

// One hidden name deleted and another added: the same counts, one shown.
var p:Object = {};
p.x = 1;
p.setPropertyIsEnumerable("x", false);
trace("all hidden", names(p));
delete p.x;
p.y = 2;
trace("hidden deleted, other added", names(p), values(p));
p.setPropertyIsEnumerable("y", false);
p.x = 1;
trace("hidden again, deleted one back", names(p));

// A name shown during a walk is gone through if the walk has not passed it.
var a:Array = [10, 20];
a.n = 30;
a.setPropertyIsEnumerable("n", false);
trace("array, name hidden", names(a), values(a));
var walked:Array = [];
for (var k:* in a) {
  walked.push(String(k));
  if (k == 0) {
    a.setPropertyIsEnumerable("n", true);
  }
}

trace("array, name shown during the walk", walked.join(","));
a.setPropertyIsEnumerable("n", false);
walked = [];
for (var i:* in o) {
  walked.push(String(i));
  a.setPropertyIsEnumerable("n", true);
}

trace("other object walked", walked.join(","), names(a));

// Prototypes with something to walk, after walks that found them empty:
// names added to Array.prototype, an Array's elements and a Dictionary's
// keys on a function's prototype.
trace("array before", names([1]), names([]));
Array.prototype.added = 4;
trace("array prototype name", names([1]), names([]));
Array.prototype.setPropertyIsEnumerable("added", false);
trace("array prototype name hidden", names([1]));
Array.prototype.setPropertyIsEnumerable("added", true);
trace("array prototype name shown", names([1]));
delete Array.prototype.added;
trace("array prototype name deleted", names([1]));

function FromArray():void {}
var elements:Array = [];
FromArray.prototype = elements;
trace("array prototype, empty", names(new FromArray()));
elements.push(7, 8);
trace("array prototype, elements", names(new FromArray()), values(new FromArray()));

function FromDictionary():void {}
var keyed:Dictionary = new Dictionary();
FromDictionary.prototype = keyed;
trace("dictionary prototype, empty", names(new FromDictionary()));
keyed["k"] = 9;
trace("dictionary prototype, a key", names(new FromDictionary()), values(new FromDictionary()));

function Chained():void {}
var middle:Object = {};
Chained.prototype = middle;
trace("chained, empty", names(new Chained()));
middle.m = 10;
trace("chained, a name", names(new Chained()), values(new Chained()));
