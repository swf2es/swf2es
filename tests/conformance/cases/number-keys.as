// obj[i] for a whole number i on objects that keep no elements: a Dictionary's
// and an Object's dynamic properties by the number's name, found, absent,
// undefined, deleted and on a prototype; a class's and a Proxy's are asked in full.
import flash.utils.Dictionary;
import flash.utils.Proxy;
import flash.utils.flash_proxy;

function read(o:*, i:uint):* {
  return o[i];
}
function readInt(o:*, i:int):* {
  return o[i];
}

var handles:Dictionary = new Dictionary();
handles[4278392] = "handle";
handles[0] = "zero";
handles["7"] = "seven by a string";
trace("dictionary", read(handles, 4278392), read(handles, 0), read(handles, 7), read(handles, 8));
handles[4278392] = undefined;
trace("undefined value", read(handles, 4278392), 4278392 in handles);
delete handles[4278392];
trace("deleted", read(handles, 4278392), 4278392 in handles);
handles[9] = null;
trace("null value", read(handles, 9));
trace("negative", readInt(handles, -1));
handles[-1] = "minus one";
trace("negative set", readInt(handles, -1));
handles[4294967295] = "max";
trace("largest", read(handles, 4294967295));

var plain:Object = {};
plain[12] = "twelve";
trace("object", read(plain, 12), read(plain, 13));
Object.prototype[13] = "on the prototype";
trace("prototype", read(plain, 13), read(handles, 13));
plain[13] = "own";
trace("own before prototype", read(plain, 13));
delete Object.prototype[13];
trace("prototype gone", read(handles, 13));

var weak:Dictionary = new Dictionary(true);
weak[5] = "weak five";
trace("weak keys", read(weak, 5));
var key:Object = {};
handles[key] = "object key";
trace("object key beside", handles[key], read(handles, 0));

dynamic class Box {
  public var value:int = 3;
}
var box:Box = new Box();
box[2] = "two";
trace("dynamic class", read(box, 2), read(box, 3));

class Sealed {}
try {
  trace(read(new Sealed(), 1));
} catch (e:Error) {
  trace("sealed", e.errorID);
}

class Names extends Proxy {
  override flash_proxy function getProperty(name:*):* { return "proxy " + name; }
}
trace(read(new Names(), 6));

var array:Array = [1, 2];
array[5] = 6;
trace("array", read(array, 1), read(array, 3), read(array, 5));
var fn:Function = function():void {};
fn[4] = "on a function";
trace("function", read(fn, 4));
for each (var primitive:* in ["abc", 5]) {
  try {
    trace("primitive", read(primitive, 1));
  } catch (e:Error) {
    trace("primitive", e.errorID);
  }
}
