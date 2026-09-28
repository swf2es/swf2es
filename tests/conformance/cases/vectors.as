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
