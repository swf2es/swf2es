// Repeated runtime string names keep seeing mutations, prototypes, hooks and namespace sets.
import flash.utils.Dictionary;
import flash.utils.Proxy;
import flash.utils.flash_proxy;

function read(o:*, name:*):* {
  return o[name];
}
function write(o:*, name:*, value:*):void {
  o[name] = value;
}
function call(o:*, name:String):* {
  return o[name]();
}

var object:Object = {value: 1};
for (var i:int = 0; i < 4; i++) {
  write(object, "value", i);
  trace("value", read(object, "value"));
}
Object.prototype.value = 9;
delete object.value;
trace("prototype", read(object, "value"));
Object.prototype.value = 12;
trace("changed prototype", read(object, "value"));
delete Object.prototype.value;
trace("deleted", read(object, "value"));
for (i = 0; i < 100; i++) {
  write(object, "key" + i, i);
}
trace("many names", read(object, "key0"), read(object, "key99"));

class Box {
  public var value:int = 17;
  public function answer():int { return value; }
}
var box:Box = new Box();
trace("slot", read(box, "value"), call(box, "answer"));
write(box, "value", 21);
trace("changed slot", read(box, "value"), call(box, "answer"));
var array:Array = [3, 5];
trace("indexed strings", read(array, "0"), read(array, "length"));
delete array[0];
trace("hole", read(array, "0"));

class Names extends Proxy {
  public var value:int = 1;
  override flash_proxy function getProperty(name:*):* { return String(name) + value++; }
}
var proxy:Names = new Names();
trace("proxy", read(proxy, "item"), read(proxy, "item"));
var xml:XML = <root><item>one</item></root>;
trace("xml", read(xml, "item"));
xml.item = "two";
trace("changed xml", read(xml, "item"));

var conversions:int = 0;
var key:Object = {toString: function():String { return "key" + conversions++; }};
trace("converted each time", read(object, key), read(object, key), conversions);
var dictionary:Dictionary = new Dictionary();
dictionary[key] = "object key";
trace("dictionary", read(dictionary, key), conversions);
