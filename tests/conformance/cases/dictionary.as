// Dictionary: keyed by an object itself, by anything else as a name; in,
// hasOwnProperty (which takes a string), delete, for-in and for each, weak
// keys; and the names a for-in gives as numbers, for any object: an index
// while avmplus' 29-bit int atom holds it.
import flash.utils.Dictionary;
function probe(name:String, f:Function):void { try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); } }
var a:Object = {}; var b:Object = {}; var arr:Array = [1];
var d:Dictionary = new Dictionary();
d[a] = "A"; d[b] = "B"; d[arr] = "arr"; d["s"] = "S"; d[1] = "one"; d[1.5] = "half"; d[true] = "T"; d[null] = "N";
probe("get", function():* { return [d[a], d[b], d[arr], d["s"], d[1], d["1"], d[1.5], d["1.5"], d[true], d["true"], d[null], d["null"], d[{}]].join(","); });
probe("in", function():* { return [a in d, {} in d, "s" in d, 1 in d, "1" in d, d.hasOwnProperty(a), d.hasOwnProperty("s")].join(","); });
var keys:Array = []; for (var k:* in d) keys.push(typeof k + ":" + (k === a ? "a" : k === b ? "b" : k === arr ? "arr" : String(k)));
probe("keys", function():* { return keys.sort().join(" "); });
var values:Array = []; for each (var v:* in d) values.push(v);
probe("values", function():* { return values.sort().join(" "); });
probe("delete", function():* { var r:* = delete d[a]; return r + " " + (a in d) + " " + d[a]; });
probe("string key of object", function():* { return d[String(b)]; });
var o:Object = {}; o[1] = "x"; o["2"] = "y";
var ok:Array = []; for (var q:* in o) ok.push(typeof q + ":" + q);
probe("object keys", function():* { return ok.sort().join(" "); });
var weak:Dictionary = new Dictionary(true);
weak[a] = 1;
probe("weak", function():* { return weak[a]; });
var dd:Dictionary = new Dictionary();
dd[1] = "a"; dd[2] = "b";
var nk:Array = []; for (var n:* in dd) nk.push(typeof n);
probe("number keys", function():* { return nk.join(","); });
probe("dictionary is dynamic", function():* { d.foo = 3; return d.foo; });
probe("dictionary length", function():* { return d.length; });

var names:Array = ["0", "1", "-1", "01", "1.0", "1e3", "268435455", "268435456", "2147483647", "2147483648", "4294967294", "4294967295", "4294967296", " 1", "x"];
var ko:Object = {};
for each (var n:String in names) ko[n] = n;
var r:Array = [];
for (var k:* in ko) r.push(k + "=" + typeof k);
trace("object", r.sort().join(" "));
var nums:Object = {};
nums[5] = 1; nums[-2] = 1; nums[2.5] = 1; nums[4294967295] = 1; nums[1e21] = 1;
var r2:Array = [];
for (var k2:* in nums) r2.push(k2 + "=" + typeof k2);
trace("numbers", r2.sort().join(" "));
var dk:Dictionary = new Dictionary();
for each (var m:String in names) dk[m] = m;
var r3:Array = [];
for (var k3:* in dk) r3.push(k3 + "=" + typeof k3);
trace("dictionary", r3.sort().join(" "));

// In AMF3: a reference, the entries' count, weak keys, then keys and values.
import flash.utils.ByteArray;
function amfBytes(v:*):String { var b:ByteArray = new ByteArray(); b.writeObject(v); var s:String = ""; for (var i:int = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16); return s; }
function amfBack(v:*):* { var b:ByteArray = new ByteArray(); b.writeObject(v); b.position = 0; return b.readObject(); }
var one:Dictionary = new Dictionary(); one["k"] = 1;
var weakOne:Dictionary = new Dictionary(true); weakOne["k"] = 1;
var byObject:Dictionary = new Dictionary(); byObject[a] = 2;
trace("amf", amfBytes(new Dictionary()), amfBytes(one), amfBytes(weakOne), amfBytes(byObject), amfBytes([one, one]));
var mixed:Dictionary = new Dictionary();
var ka:Object = {n: 1}; var kb:Array = [2];
mixed[ka] = "object"; mixed[kb] = "array"; mixed["s"] = "string"; mixed[7] = "seven";
var got:Dictionary = amfBack([mixed, ka])[0];
var gotKeys:Array = [];
for (var gk:* in got) gotKeys.push(typeof gk + ":" + (typeof gk == "object" ? got[gk] : String(gk) + "=" + got[gk]));
trace("amf back", gotKeys.sort().join(" "), got is Dictionary);
var pair:Array = amfBack([mixed, ka]);
trace("amf key identity", pair[0][pair[1]]);
