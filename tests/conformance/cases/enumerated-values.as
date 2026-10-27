// Reading enumerated values still respects native hooks, inherited indices and subclasses.
package {
  public dynamic class EnumeratedArray extends Array {
    override public function get length():uint {
      trace("subclass length");
      return 2;
    }
  }
}
package {
  public dynamic class EnumeratedObject {
    public function get bound():String { return "getter"; }
  }
}
package {
  import flash.utils.Proxy;
  import flash.utils.flash_proxy;
  public dynamic class EnumeratedProxy extends Proxy {
    override flash_proxy function nextNameIndex(i:int):int { return i < 2 ? i + 1 : 0; }
    override flash_proxy function nextName(i:int):String { return "key" + i; }
    override flash_proxy function nextValue(i:int):* { return "value" + i; }
    override flash_proxy function getProperty(name:*):* { return "get:" + String(name); }
    override flash_proxy function hasProperty(name:*):Boolean { return String(name) == "key1"; }
  }
}

import flash.utils.ByteArray;
import flash.utils.Dictionary;

function values(o:*):String {
  var out:Array = [];
  for each (var value:* in o) { out.push(String(value)); }
  return out.sort().join("|");
}
function pairs(o:*):String {
  var out:Array = [];
  for (var name:* in o) { out.push(String(name) + ":" + String(o[name])); }
  return out.sort().join("|");
}

var dense:Array = [10, null, undefined, 40];
trace("dense", values(dense), pairs(dense));
var sparse:Array = [];
sparse[0] = "own0";
sparse[3] = undefined;
sparse[100000] = "far";
sparse["01"] = "string-index";
sparse.note = "note";
Array.prototype[1] = "prototype1";
Array.prototype[3] = "prototype3";
trace("sparse", values(sparse), pairs(sparse));
delete Array.prototype[1];
delete Array.prototype[3];

var object:Object = {zero: 0, missing: undefined, empty: null, "01": "numeric-name"};
Object.prototype.inheritedValue = "prototype";
Object.prototype.missing = "hidden-by-undefined";
trace("object", values(object), pairs(object));
delete Object.prototype.inheritedValue;
delete Object.prototype.missing;

var arraySubclass:EnumeratedArray = new EnumeratedArray();
arraySubclass[0] = "a";
arraySubclass[2] = "c";
arraySubclass.extra = "subclass";
trace("array subclass", values(arraySubclass), pairs(arraySubclass));
trace("generic length", Array.prototype.join.call(arraySubclass, ":"));
var objectSubclass:EnumeratedObject = new EnumeratedObject();
objectSubclass.extra = "dynamic";
EnumeratedObject.prototype.inherited = "inherited";
trace("object subclass", values(objectSubclass), pairs(objectSubclass), objectSubclass.bound);
delete EnumeratedObject.prototype.inherited;

var proxy:* = new EnumeratedProxy();
trace("proxy", values(proxy), pairs(proxy), 0 in proxy);
var dictionary:Dictionary = new Dictionary();
var key:Object = {toString: function():String { return "object-key"; }};
dictionary[key] = "object-value";
dictionary["text"] = "string-value";
dictionary[0] = "number-value";
dictionary["undefined"] = undefined;
trace("dictionary", values(dictionary), pairs(dictionary));

var vector:Vector.<int> = new <int>[3, 1, 2];
trace("vector", values(vector), pairs(vector));
var bytes:ByteArray = new ByteArray();
bytes.writeByte(5);
bytes.writeByte(6);
trace("bytes", values(bytes), pairs(bytes));
var xml:XML = <root><v>a</v><v>b</v></root>;
trace("xml", values(xml), pairs(xml));
trace("xmllist", values(xml.v), pairs(xml.v));

var changing:Array = [1, 2, 3];
var seen:Array = [];
for each (var v:* in changing) {
  seen.push(v);
  if (v === 1) {
    delete changing[1];
    changing[2] = 30;
  }
}
trace("delete array", seen, changing.length);
var changingObject:Object = {only: "original"};
var nested:Array = [];
for each (var outer:* in changingObject) {
  delete changingObject.only;
  changingObject.only = "new";
  for each (var inner:* in changingObject) { nested.push(inner); }
  nested.push(outer);
}
trace("delete object", nested);
