// A for-in goes through the names there when it starts, also where as many
// were deleted as added since the last, and a for each gives each value as
// it is when the walk gets there.
import flash.utils.Dictionary;

dynamic class Dynamic
{
	public var fixed:int = 7;
}

function names(x:*):String
{
	var seen:Array = [];
	for (var k:* in x)
	{
		seen.push(String(k));
	}

	seen.sort();
	return seen.join(",");
}

function values(x:*):String
{
	var seen:Array = [];
	for each (var v:* in x)
	{
		seen.push(String(v));
	}

	seen.sort();
	return seen.join(",");
}

var o:Object = {a: 1, b: 2};
trace("object", names(o), values(o));
delete o.a;
o.c = 3;
trace("one deleted, one added", names(o), values(o));
delete o.b;
delete o.c;
o.d = 4;
o.e = 5;
trace("two deleted, two added", names(o), values(o));
o.setPropertyIsEnumerable("d", false);
delete o.e;
o.f = 6;
trace("hidden, deleted, added", names(o), values(o));

var big:Object = {};
for (var i:int = 0; i < 40; i++)
{
	big["n" + i] = i;
}

names(big);
delete big.n0;
big.m = 100;
var bigNames:String = names(big);
trace("big object", bigNames.split(",").length, bigNames.indexOf("n0,") >= 0, bigNames.indexOf("m") >= 0);

var d:Dictionary = new Dictionary();
var key:Object = {};
d["x"] = 1;
d["y"] = 2;
d[key] = 3;
trace("dictionary", values(d));
delete d["x"];
d["z"] = 4;
trace("dictionary, one deleted, one added", values(d), d["z"], "x" in d);

var dynamicObject:Dynamic = new Dynamic();
dynamicObject.extra = 8;
dynamicObject.hidden = 9;
dynamicObject.setPropertyIsEnumerable("hidden", false);
trace("dynamic class", names(dynamicObject), values(dynamicObject));

// Each value as it is when the walk gets there.
var w:Object = {p: 1, q: 1, r: 1};
var seen:Array = [];
for each (var v:* in w)
{
	seen.push(v);
	for (var k:* in w)
	{
		w[k] = 10;
	}
}

seen.sort(Array.NUMERIC);
trace("values changed during the walk", seen.join(","));

var gone:Object = {p: 1, q: 2, r: 3};
var count:int = 0;
for each (var g:* in gone)
{
	count++;
	for (var k2:* in gone)
	{
		if (gone[k2] !== g)
		{
			delete gone[k2];
		}
	}
}

trace("others deleted during the walk", count, names(gone).split(",").length);
