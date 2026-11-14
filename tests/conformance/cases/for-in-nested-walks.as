// for-ins inside for-ins, over the same object and over others, left by
// break, return and a thrown error, and over an object whose elements
// change under them: pushed, emptied, replaced by a Vector's length = 0,
// and whose names are hidden by setPropertyIsEnumerable. Each step reads
// the object as it is then, whatever another for-in went through in
// between.
import flash.utils.Dictionary;

function sorted(names:Array):String
{
	names.sort();
	return names.join(",");
}

// The same Array inside itself, by names and by values.
var a:Array = ["a", "b", "c"];
var pairs:Array = [];
for (var i:* in a)
{
	for (var j:* in a)
	{
		pairs.push(i + "" + j);
	}
}
trace("same-in", pairs.join(" "));

pairs = [];
for each (var x:* in a)
{
	for each (var y:* in a)
	{
		pairs.push(x + y);
	}
}
trace("same-each", pairs.join(" "));

// Others inside: a Vector, an Object, a Dictionary, and the Array again.
var v:Vector.<int> = new <int>[10, 20];
var o:Object = {p: 1, q: 2};
var d:Dictionary = new Dictionary();
d["k"] = "dk";
d[a] = "da";
pairs = [];
for (i in a)
{
	var row:Array = [];
	for each (x in v)
	{
		row.push(x);
	}

	var names:Array = [];
	for (j in o)
	{
		names.push(j + "=" + o[j]);
	}

	row.push(sorted(names));
	names = [];
	for each (x in d)
	{
		names.push(x);
	}

	row.push(sorted(names));
	for (j in a)
	{
		row.push(j);
	}

	pairs.push(i + ":" + row.join("/"));
}
trace("others", pairs.join(" "));

// Three deep, the middle one over another object.
var count:int = 0;
var last:String = "";
for (i in a)
{
	for each (x in v)
	{
		for (j in a)
		{
			count++;
			last = i + "," + x + "," + j;
		}
	}
}
trace("three", count, last);

// An inner for-in left by break, at its first step and at its last.
pairs = [];
for (i in a)
{
	for (j in a)
	{
		if (j == i)
		{
			break;
		}

		pairs.push(i + "" + j);
	}
}
trace("break", pairs.join(" "));

// Left by continue to the outer one.
pairs = [];
outer: for (i in a)
{
	for (j in a)
	{
		if (j > i)
		{
			continue outer;
		}

		pairs.push(i + "" + j);
	}
}
trace("continue", pairs.join(" "));

// Left by return.
function firstAfter(list:Array, name:int):*
{
	for (var k:* in list)
	{
		if (k > name)
		{
			return list[k];
		}
	}

	return null;
}

pairs = [];
for (i in a)
{
	pairs.push(i + "=" + firstAfter(a, i));
}
trace("return", pairs.join(" "));

// Left by a thrown error, caught in the outer one's body.
function throwsAt(list:Array, name:int):void
{
	for (var k:* in list)
	{
		if (k == name)
		{
			throw new Error("at " + k);
		}
	}
}

pairs = [];
for (i in a)
{
	try
	{
		throwsAt(a, i);
	}
	catch (e:Error)
	{
		pairs.push(i + ":" + e.message);
	}
}
trace("throw", pairs.join(" "));

// The outer one's object changed in the inner one: an element set, one
// deleted ahead, one pushed.
var m:Array = [0, 1, 2, 3];
pairs = [];
for (i in m)
{
	for (j in m)
	{
		if (i == 0 && j == 0)
		{
			m[1] = "set";
			delete m[2];
			m.push("pushed");
		}
	}

	pairs.push(i + "=" + m[i]);
}
trace("inner-mutation", pairs.join(" "), m.length);

// A for-in reaches what is pushed during it.
var q:Array = [1, 2];
count = 0;
for (i in q)
{
	count++;
	if (q.length < 7)
	{
		q.push(count);
	}
}
trace("push-in", count, q.join(","));

q = [1, 2];
pairs = [];
for each (x in q)
{
	pairs.push(x);
	if (q.length < 7)
	{
		q.push(x * 10);
	}
}
trace("push-each", pairs.join(","));

// A queue that fills as it is walked, emptied after, and walked again.
var queue:Array = [];
function drain():int
{
	var n:int = 0;
	for (var s:int = 0; s < 3; s++)
	{
		queue.push(s);
	}

	for each (var e:* in queue)
	{
		n++;
		if (queue.length < 20)
		{
			queue.push(n);
		}
	}

	queue.length = 0;
	return n;
}
trace("queue", drain(), drain(), queue.length);

// length = 0 during a for-in ends it; elements pushed after are walked.
q = [1, 2, 3, 4];
pairs = [];
for (i in q)
{
	pairs.push(i);
	if (i == 1)
	{
		q.length = 0;
	}
}
trace("emptied-in", pairs.join(","), q.length);

q = [1, 2, 3, 4];
pairs = [];
for each (x in q)
{
	pairs.push(x);
	if (x == 2)
	{
		q.length = 0;
		q.push("a", "b", "c", "d");
	}
}
trace("emptied-refilled", pairs.join(","), q.length);

// The same over a Vector, whose length = 0 may give it other storage.
var w:Vector.<int> = new <int>[1, 2, 3, 4];
pairs = [];
for (i in w)
{
	pairs.push(i);
	if (i == 1)
	{
		w.length = 0;
	}
}
trace("vector-emptied-in", pairs.join(","), w.length);

w = new <int>[1, 2, 3, 4];
pairs = [];
for each (x in w)
{
	pairs.push(x);
	if (x == 2)
	{
		w.length = 0;
		w.push(7, 8, 9, 10);
	}
}
trace("vector-emptied-refilled", pairs.join(","), w.length);

w = new <int>[1, 2, 3];
pairs = [];
for each (x in w)
{
	pairs.push(x);
	if (w.length < 6)
	{
		w.push(x + 10);
	}
}
trace("vector-push", pairs.join(","));

var strings:Vector.<String> = new <String>["s", "t"];
pairs = [];
for each (x in strings)
{
	for (j in strings)
	{
		pairs.push(x + j);
		if (strings.length < 4)
		{
			strings.push(x + x);
		}
	}
}
trace("vector-nested-push", pairs.join(" "));

// A name hidden during a for-in, the object's first hidden one, is passed
// over: by the for-in under way, and by an outer one when an inner one
// hides it.
var h:Array = ["a", "b"];
h.extra = "e";
pairs = [];
for (i in h)
{
	pairs.push(i);
	if (i == 0)
	{
		h.setPropertyIsEnumerable("extra", false);
	}
}
trace("hidden-in", pairs.join(","));

h = ["a", "b"];
h.extra = "e";
pairs = [];
for each (x in h)
{
	pairs.push(x);
	if (x == "b")
	{
		h.setPropertyIsEnumerable("extra", false);
	}
}
trace("hidden-each", pairs.join(","));

h = ["a", "b"];
h.extra = "e";
pairs = [];
for (i in h)
{
	for (j in h)
	{
		if (i == 1 && j == 0)
		{
			h.setPropertyIsEnumerable("extra", false);
		}
	}

	pairs.push(i);
}
trace("hidden-inner", pairs.join(","));

var hiding:Object = {a: 1, b: 2, c: 3};
count = 0;
for (i in hiding)
{
	count++;
	for (j in hiding)
	{
		if (j != i)
		{
			hiding.setPropertyIsEnumerable(j, false);
		}
	}
}
trace("hidden-object", count);

// The names not yet walked hidden at the first one, with no for-in between.
function hideOthers(target:Object, all:Array, but:*):void
{
	for (var n:int = 0; n < all.length; n++)
	{
		if (all[n] != but)
		{
			target.setPropertyIsEnumerable(all[n], false);
		}
	}
}

hiding = {a: 1, b: 2, c: 3};
count = 0;
for (i in hiding)
{
	count++;
	hideOthers(hiding, ["a", "b", "c"], i);
}
trace("hidden-others", count);

h = ["a"];
h.x = 1;
h.y = 2;
h.z = 3;
count = 0;
for each (x in h)
{
	count++;
	if (x is Number)
	{
		hideOthers(h, ["x", "y", "z"], ["", "x", "y", "z"][x]);
	}
}
trace("hidden-others-array", count);

// Names past the elements, in an inner for-in and an outer one.
var named:Array = [1, 2];
named.extra = "e";
pairs = [];
for (i in named)
{
	for each (x in named)
	{
		pairs.push(i + ":" + x);
	}
}
trace("named", pairs.join(" "));

// An Object inside itself, a name added in the inner for-in.
var obj:Object = {a: 1, b: 2, c: 3};
count = 0;
names = [];
for (i in obj)
{
	for (j in obj)
	{
		count++;
	}

	names.push(i);
}
trace("object", count, sorted(names));

// A Dictionary inside itself, and inside an Array's.
var keyA:Object = {};
var keyB:Object = {};
var dict:Dictionary = new Dictionary();
dict[keyA] = 1;
dict[keyB] = 2;
dict["s"] = 3;
var sum:int = 0;
count = 0;
for (var k:* in dict)
{
	for each (x in dict)
	{
		sum += x;
		count++;
	}
}
trace("dictionary", count, sum);

sum = 0;
for each (x in a)
{
	for (k in dict)
	{
		sum += dict[k];
	}

	for each (y in dict)
	{
		sum += y;
	}
}
trace("dictionary-in-array", sum);

// One for-in's steps between another's hasnext and its name: the walks
// share nothing but the objects.
function walkBoth(first:*, second:*):String
{
	var out:Array = [];
	for (var n:* in first)
	{
		var inner:Array = [];
		for each (var e:* in second)
		{
			inner.push(e);
		}

		out.push(n + "[" + inner.join("") + "]" + first[n]);
	}

	return out.join(" ");
}
trace("both", walkBoth(a, v));
trace("both", walkBoth(v, a));
trace("both", walkBoth(a, a));
trace("both", walkBoth(w, w));
