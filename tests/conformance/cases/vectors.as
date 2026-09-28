// Vectors of each kind: construction, conversion, elements, and methods.
var vi:Vector.<int> = new <int>[3, 1, 2];
var vu:Vector.<uint> = Vector.<uint>([1, -1, 2.7]);
var vd:Vector.<Number> = new Vector.<Number>(3);
var vs:Vector.<String> = new <String>["b", "a"];
var vo:Vector.<Object> = new Vector.<Object>();
trace(vi, vu, vd, vs, vo.length, vi.length, vd[0], vi[1] + 1);
vi.push(10.9, "5");
vs.push(null, 1);
vd[3] = 1.5;
trace(vi, vs, vd, vi.indexOf(10), vi.lastIndexOf(99));
trace(vi.slice(1, 3), vi.concat(new <int>[7]), vi.join("|"), vi.reverse());
vi.sort(function(a:int, b:int):Number { return a - b; });
trace(vi, vi.pop(), vi.shift(), vi.unshift(0), vi);
trace(vi.splice(1, 1), vi, vi.map(function(x:int, i:int, v:Vector.<int>):int { return x * 2; }));
trace(vi.filter(function(x:int, i:int, v:Vector.<int>):Boolean { return x > 1; }), vi.some(function(x:int, i:int, v:Vector.<int>):Boolean { return x > 5; }));
vi.length = 6;
trace(vi, vi.fixed);
vi.fixed = true;
trace(vi.fixed, vi is Vector.<int>, vs is Vector.<String>, vs is Vector.<*>, vo is Vector.<Object>, vi is Vector.<Number>);
var vv:Vector.<Vector.<int>> = new Vector.<Vector.<int>>();
vv.push(new <int>[1, 2]);
trace(vv.length, vv[0][1], String(vv));
for each (var x:int in new <int>[4, 5]) trace("each", x);
for (var i:* in new <int>[4, 5]) trace("in", i);
// Length set: emptied and used again, grown with the type's default, shrunk.
var lv:Vector.<int> = new Vector.<int>();
lv.push(1, 2, 3);
lv.length = 0;
lv.push(4);
lv.length = 3;
trace("length reset", lv, lv.length);
lv.length = 1;
trace("length shrunk", lv, lv.length);
var ls:Vector.<String> = new Vector.<String>();
ls.length = 2;
trace("length grown", ls[0], ls[1], ls.length);
var ld:Vector.<Number> = new Vector.<Number>(2);
ld.length = 0;
ld.length = 2;
trace("length regrown", ld);
var lf:Vector.<int> = new Vector.<int>(2, true);
try { lf.length = 0; } catch (e:RangeError) { trace("fixed length", e.errorID, lf.length); }
// Emptied while forEach goes through it.
var le:Vector.<int> = new Vector.<int>();
le.push(1, 2, 3);
var leSeen:Array = [];
try {
    le.forEach(function (x:int, i:int, v:Vector.<int>):void { leSeen.push(x); if (i == 0) v.length = 0; });
} catch (e:RangeError) { leSeen.push("RangeError " + e.errorID); }
trace("emptied in forEach", leSeen, le.length);

// Writes whose value's conversion runs AS3 that changes the Vector: as
// avmplus, converted first, then checked against the Vector as it is then,
// and written into its elements as they are then.
function vprobe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); }
}
var v:Vector.<int>;
function clearing(n:Number):Object { return { valueOf: function():Number { v.length = 0; return n; } }; }
function fixing(n:Number):Object { return { valueOf: function():Number { v.fixed = true; return n; } }; }
function growing(n:Number):Object { return { valueOf: function():Number { v.push(99); return n; } }; }
var i0:int = 0, i1:int = 1, i2:int = 2;
vprobe("set 0 cleared", function():* { v = new <int>[1, 2]; v[i0] = clearing(7) as int; return v.length + " " + v; });
vprobe("set 0 cleared untyped", function():* { v = new <int>[1, 2]; var x:* = clearing(7); v[i0] = x; return v.length + " " + v; });
vprobe("set 1 cleared", function():* { v = new <int>[1, 2]; var x:* = clearing(7); v[i1] = x; return v.length + " " + v; });
vprobe("append cleared", function():* { v = new <int>[1, 2]; var x:* = clearing(7); v[i2] = x; return v.length + " " + v; });
vprobe("append fixed", function():* { v = new <int>[1, 2]; var x:* = fixing(7); v[i2] = x; return v.length + " " + v; });
vprobe("append grown", function():* { v = new <int>[1, 2]; var x:* = growing(7); v[i2] = x; return v.length + " " + v; });
vprobe("dynamic set cleared", function():* { v = new <int>[1, 2]; var o:Object = v; o[i0] = clearing(7); return v.length + " " + v; });
vprobe("dynamic append cleared", function():* { v = new <int>[1, 2]; var o:Object = v; o[i2] = clearing(7); return v.length + " " + v; });
vprobe("push cleared", function():* { v = new <int>[1, 2]; var r:* = v.push(clearing(7)); return r + " " + v.length + " " + v; });
vprobe("push 3 cleared", function():* { v = new <int>[1, 2]; var r:* = v.push(3, clearing(7), 5); return r + " " + v.length + " " + v; });
vprobe("push fixed", function():* { v = new <int>[1, 2]; var r:* = v.push(3, fixing(7), 5); return r + " " + v.length + " " + v; });
vprobe("unshift cleared", function():* { v = new <int>[1, 2]; var r:* = v.unshift(clearing(7)); return r + " " + v.length + " " + v; });
vprobe("unshift 2 cleared", function():* { v = new <int>[1, 2]; var r:* = v.unshift(3, clearing(7)); return r + " " + v.length + " " + v; });
vprobe("splice cleared", function():* { v = new <int>[1, 2, 3]; var r:* = v.splice(1, 1, clearing(7)); return r + " " + v.length + " " + v; });
vprobe("splice converts", function():* { v = new <int>[1, 2, 3]; v.splice(1, 0, 2.5, "4"); return v.length + " " + v; });
vprobe("length cleared", function():* { v = new <int>[1, 2]; var n:* = clearing(5); v.length = n; return v.length + " " + v; });
vprobe("length grown", function():* { v = new <int>[1, 2]; var n:* = growing(1); v.length = n; return v.length + " " + v; });
var vs:Vector.<String>;
vprobe("string set cleared", function():* { vs = new <String>["a", "b"]; var x:* = { toString: function():String { vs.length = 0; return "z"; } }; vs[0] = x; return vs.length + " " + vs; });
vprobe("push grown", function():* { v = new <int>[1, 2]; var r:* = v.push(growing(7), 5); return r + " " + v.length + " " + v; });
var src:Vector.<Object>;
vprobe("convert source cleared", function():* { src = new <Object>[1, { valueOf: function():Number { src.length = 0; return 2; } }, 3]; var w:Vector.<int> = Vector.<int>(src); return w.length + " " + w + " " + src.length; });
vprobe("unshift fixed", function():* { v = new <int>[1, 2]; var r:* = v.unshift(fixing(7)); return r + " " + v.length + " " + v + " " + v.fixed; });
vprobe("splice grown", function():* { v = new <int>[1, 2, 3]; var r:* = v.splice(1, 1, growing(7)); return r + " " + v.length + " " + v; });
