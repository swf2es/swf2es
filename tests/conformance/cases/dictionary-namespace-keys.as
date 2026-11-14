// A Namespace as a Dictionary's key: no object to avmplus
// (isDictionaryLookup), so it names its uri, as it does for any other
// object, in get, set, compound assignment, delete, hasOwnProperty,
// propertyIsEnumerable, `in` and the walks after them; the same in script
// code, which avmshell interprets, and in functions, which it compiles. A
// QName names its namespace and local name in compiled code; avmshell's
// interpreter keys a Dictionary by the QName itself instead, so its cases
// stay in functions.
import flash.utils.Dictionary;

function probe(label:String, f:Function):void
{
	try
	{
		trace(label, f());
	}
	catch (e:Error)
	{
		trace(label, "error", e.errorID);
	}
}

function keysOf(d:Object):String
{
	var r:Array = [];
	for (var k:* in d)
	{
		r.push(typeof k + ":" + String(k) + (k is Namespace ? "(ns)" : k is QName ? "(qn)" : ""));
	}
	r.sort();
	return r.join(" ");
}

function valuesOf(d:Object):String
{
	var r:Array = [];
	for each (var v:* in d)
		r.push(String(v));
	r.sort();
	return r.join(" ");
}

function setKey(d:Dictionary, k:*, v:*):void
{
	d[k] = v;
}
function getKey(d:Dictionary, k:*):*
{
	return d[k];
}
function addKey(d:Dictionary, k:*, v:*):void
{
	d[k] += v;
}
function deleteKey(d:Dictionary, k:*):Boolean
{
	return delete d[k];
}

function qnames(d:Dictionary):void
{
	var q:QName = new QName("http://x", "y");
	var q2:QName = new QName("http://x", "y");
	var pq:QName = new QName("", "z");
	var pq2:QName = new QName("", "z");
	probe("qname get absent", function():*
		{
			return d[q];
		});
	probe("qname set", function():*
		{
			d[q] = 10;
			return d[q];
		});
	probe("qname other", function():*
		{
			return d[q2];
		});
	probe("qname keys", function():*
		{
			return keysOf(d);
		});
	probe("qname in", function():*
		{
			return [q in d, q2 in d, "http://x::y" in d].join(",");
		});
	probe("qname delete", function():*
		{
			return delete d[q];
		});
	probe("public qname set", function():*
		{
			d[pq] = 11;
			return [d[pq], d[pq2], d["z"]].join(",");
		});
	probe("public qname keys", function():*
		{
			return keysOf(d);
		});
	probe("public qname in", function():*
		{
			return [pq in d, pq2 in d, "z" in d].join(",");
		});
	probe("public qname hasOwnProperty", function():*
		{
			return d.hasOwnProperty(pq);
		});
	probe("public qname compound", function():*
		{
			addKey(d, pq2, 1);
			return d["z"];
		});
	probe("public qname delete", function():*
		{
			return [deleteKey(d, pq2), keysOf(d)].join(",");
		});
}

for each (var weak:Boolean in [false, true])
{
	trace(weak ? "weak" : "strong");
	var d:Dictionary = new Dictionary(weak);
	var ns:Namespace = new Namespace("http://x");
	var ns2:Namespace = new Namespace("http://x");
	var pns:Namespace = new Namespace("p", "http://x");
	var empty:Namespace = new Namespace("");

	// Script code.
	probe("get absent", function():*
		{
			return d[ns];
		});
	d[ns] = 1;
	probe("get", function():*
		{
			return [d[ns], d[ns2], d[pns], d["http://x"]].join(",");
		});
	probe("keys", function():*
		{
			return keysOf(d);
		});
	probe("values", function():*
		{
			return valuesOf(d);
		});
	probe("in", function():*
		{
			return [ns in d, ns2 in d, pns in d, "http://x" in d].join(",");
		});
	probe("hasOwnProperty", function():*
		{
			return [d.hasOwnProperty(ns), d.hasOwnProperty("http://x")].join(",");
		});
	probe("propertyIsEnumerable", function():*
		{
			return d.propertyIsEnumerable(ns);
		});
	d[ns2] += 1;
	probe("compound", function():*
		{
			return [d[ns], d["http://x"]].join(",");
		});
	d[pns]++;
	probe("increment", function():*
		{
			return d["http://x"];
		});
	d["http://x"] = 7;
	probe("string set", function():*
		{
			return d[ns];
		});
	probe("delete", function():*
		{
			return delete d[ns2];
		});
	probe("after delete", function():*
		{
			return [d[ns], ns in d, d["http://x"], keysOf(d)].join(",");
		});
	probe("delete absent", function():*
		{
			return delete d[ns];
		});
	d[empty] = 3;
	probe("empty uri", function():*
		{
			return [d[empty], d[""], keysOf(d)].join(",");
		});
	delete d[empty];
	probe("empty deleted", function():*
		{
			return keysOf(d);
		});

	// Compiled code.
	setKey(d, pns, 4);
	probe("function get", function():*
		{
			return [getKey(d, ns), getKey(d, "http://x"), keysOf(d)].join(",");
		});
	addKey(d, ns, 1);
	probe("function compound", function():*
		{
			return d["http://x"];
		});
	probe("function delete", function():*
		{
			return [deleteKey(d, ns2), keysOf(d)].join(",");
		});

	// Beside an object key, which is the object itself.
	var obj:Object = {};
	d[obj] = 4;
	d[ns] = 5;
	probe("beside object", function():*
		{
			return [d[obj], d[ns], keysOf(d).replace("[object Object]", "obj")].join(",");
		});
	delete d[obj];
	delete d[ns];
	probe("empty again", function():*
		{
			return keysOf(d);
		});

	// A name on the prototype.
	Dictionary.prototype["http://proto"] = 9;
	probe("on prototype", function():*
		{
			var p:Namespace = new Namespace("http://proto");
			return [d[p], p in d, d.hasOwnProperty(p)].join(",");
		});
	delete Dictionary.prototype["http://proto"];

	// A Namespace as a value is itself.
	d["v"] = ns;
	probe("namespace value", function():*
		{
			return [d["v"] === ns, String(d["v"])].join(",");
		});
	delete d["v"];

	qnames(d);
	probe("left", function():*
		{
			return keysOf(d);
		});
}

// Not a Dictionary: the same names.
var o:Object = {};
var ns3:Namespace = new Namespace("http://x");
o[ns3] = 1;
probe("object", function():*
	{
		return [o[ns3], o["http://x"], keysOf(o), ns3 in o, o.hasOwnProperty(ns3)].join(",");
	});
probe("object delete", function():*
	{
		return [delete o[ns3], keysOf(o)].join(",");
	});
