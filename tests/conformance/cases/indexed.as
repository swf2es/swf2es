// obj[i] with a number i, which swf2es reads and writes as an element:
// holes, prototypes, indexes that are not elements, and each kind of
// object that holds elements, or does not.
import flash.utils.ByteArray;
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID); }
}
var i:int = 0, one:uint = 1, half:Number = 1.5, neg:int = -1, big:Number = 4294967295;
var a:Array = [10, 20];
a[3] = 40;
Array.prototype[2] = "proto";
trace(a[i], a[one], a[2], a[3], a[half], a.length);
a[half] = "half"; a[neg] = "neg"; a[big] = "big";
trace(a[half], a[neg], a[big], a["1.5"], a.length, a.hasOwnProperty("1.5"));
delete Array.prototype[2];
trace(a[2]);
var v:Vector.<int> = new <int>[1, 2, 3];
v[one] = 7.9;
trace(v[i], v[one], v.length);
probe("vector past", function():* { return v[5 as int]; });
probe("vector append", function():* { var n:int = 3; v[n] = 4; return v.length; });
probe("vector gap", function():* { var n:int = 9; v[n] = 4; });
probe("vector fraction", function():* { return v[half]; });
var b:ByteArray = new ByteArray();
var k:int = 3;
b[k] = 300;
trace(b.length, b[k], b[i], b[k + 10]);
var o:Object = {};
o[i] = "zero"; o[half] = "h";
trace(o[i], o["0"], o[half], o[one]);
var s:String = "abc";
probe("string", function():* { return s[one]; });
var d:Object = new Date(0);
probe("sealed", function():* { return d[i]; });
