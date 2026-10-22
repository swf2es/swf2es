import flash.utils.ByteArray;
import flash.utils.Dictionary;
import flash.utils.Proxy;
import flash.utils.flash_proxy;

function probe(name:String, source:*):void {
  try {
    var result:Vector.<int> = Vector.<int>(source);
    trace(name, result.length, result);
  } catch (e:Error) {
    trace(name, "error", e.errorID);
  }
}

probe("dense", [1, 2.5, -3, "4", undefined, null]);
var sparse:Array = [1, 2, 3];
delete sparse[1];
probe("hole", sparse);
Array.prototype[1] = 7;
probe("inherited", sparse);
delete Array.prototype[1];

// A conversion can replace the next element or the source's backing store.
var array:Array = [null, 2, 3];
array[0] = { valueOf: function():Number {
  array.length = 0;
  array.push(8, 9);
  return 1;
} };
probe("array cleared and regrown", array);

array = [null, 2, 3];
array[0] = { valueOf: function():Number {
  delete array[1];
  array[2] = 10;
  array.push(11);
  return 1;
} };
probe("array deleted replaced appended", array);

var vector:Vector.<Object> = new <Object>[null, 2, 3];
vector[0] = { valueOf: function():Number {
  vector.length = 0;
  vector.push(8, 9, 10);
  return 1;
} };
probe("vector cleared and regrown", vector);

vector = new <Object>[null, 2, 3];
vector[0] = { valueOf: function():Number {
  vector.length = 0;
  return 1;
} };
probe("vector cleared", vector);

var bytes:ByteArray = new ByteArray();
bytes.writeByte(255);
bytes.writeByte(7);
probe("bytes", bytes);
probe("object", { length: 3, "0": 4, "1": 5, "2": 6 });

// Dictionary names must stay strings on the generic property path.
var dictionary:Dictionary = new Dictionary();
dictionary["length"] = 2;
dictionary[0] = 40;
dictionary[1] = 50;
dictionary["0"] = 4;
dictionary["1"] = 5;
probe("dictionary", dictionary);

class ConversionProxy extends Proxy {
  public var reads:Array = [];

  override flash_proxy function getProperty(name:*):* {
    reads.push(String(name));
    if (String(name) == "length") {
      return 3;
    }

    return int(String(name)) + 6;
  }
}

var proxy:ConversionProxy = new ConversionProxy();
probe("proxy", proxy);
trace("proxy reads", proxy.reads);

var same:Vector.<int> = new <int>[1, 2];
trace("identity", Vector.<int>(same) === same);
