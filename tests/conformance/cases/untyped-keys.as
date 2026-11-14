// obj[k] where the compiler knows the type of neither: swf2es looks at the
// key when the code runs (Runtime.getKeyed, setKeyed), a number an index,
// an object a Dictionary's key, anything else a name. Every kind of
// receiver by every kind of key, read, written and read again, in
// functions, which avmshell compiles, and in the script, which it
// interprets.
import flash.utils.ByteArray;
import flash.utils.Dictionary;
import flash.utils.Proxy;
import flash.utils.flash_proxy;

namespace other = "urn:other";

dynamic class Bag
{
	public var fixed:String = "fixed";
	other var x:String = "other x";
}

class Sealed
{
	public var fixed:String = "fixed";
}

dynamic class List extends Array
{
}

class Named
{
	private var _name:String;

	public function Named(name:String)
	{
		_name = name;
	}

	public function toString():String
	{
		return _name;
	}
}

dynamic class Logged extends Proxy
{
	flash_proxy override function getProperty(name:*):*
	{
		return "get " + describe(name);
	}

	flash_proxy override function setProperty(name:*, value:*):void
	{
		trace("  proxy set", describe(name), value);
	}
}

function describe(v:*):String
{
	if (v is QName)
	{
		return "QName(" + v.uri + "::" + v.localName + ")";
	}

	if (v is Function)
	{
		return "function";
	}

	if (v === undefined || v === null || v is XML || v is XMLList)
	{
		return typeof v + " " + String(v);
	}

	return typeof v + " " + v;
}

function get (o:*, k:*):*
{
	return o[k];
}

function set (o:*, k:*, v:*):void
{
	o[k] = v;
}

function getOther(o:*, k:*):*
{
	return o.other::[k];
}

function setOther(o:*, k:*, v:*):void
{
	o.other::[k] = v;
}

function getBoth(o:*, k:*):*
{
	use namespace other;
	return o[k];
}

function getAttribute(o:*, k:*):*
{
	return o.@[k];
}

function attempt(f:Function):String
{
	try
	{
		return describe(f());
	}
	catch (e:Error)
	{
		return e.name + " " + e.errorID;
	}

	return "";
}

const object:Object = {toString: function():String
	{
		return "1";
	}
};
const twin:Object = {toString: function():String
	{
		return "1";
	}
};
const named:Named = new Named("x");
const list:Array = [1];
const fn:Function = function():void
{
};
const xml:XML = <a b="attr"><x>child</x><x>second</x></a>;
const keyNames:Array = [
		"0", "1", "1.5", "-1", "NaN", "-0", "2^32-1", "2^32-2", "2^31", "2^32", "1e21",
		"'0'", "'1'", "'1.5'", "'-1'", "'x'", "'fixed'", "'length'", "''",
		"true", "null", "undefined", "object", "twin", "named", "array", "function",
		"QName x", "QName other::x", "QName *", "Namespace", "XML", "XMLList", "Class"
	];
const keys:Array = [
		0, 1, 1.5, -1, NaN, -0.0, 4294967295, 4294967294, 2147483648, 4294967296, 1e21,
		"0", "1", "1.5", "-1", "x", "fixed", "length", "",
		true, null, undefined, object, twin, named, list, fn,
		new QName("", "x"), new QName(other, "x"), new QName("*"), other, xml.x[0], xml.x, Named
	];

function receivers():Array
{
	const array:Array = [10, 11];
	array[3] = 13;
	array.x = "ax";

	const sub:List = new List();
	sub.push(20, 21);

	const strong:Dictionary = new Dictionary();
	strong[0] = "d0";
	strong["x"] = "dx";
	strong[object] = "dobject";
	strong[named] = "dnamed";

	const weak:Dictionary = new Dictionary(true);
	weak[1] = "w1";
	weak[list] = "wlist";
	weak[fn] = "wfn";

	const plain:Object = {x: "ox", 1: "o1"};
	const bag:Bag = new Bag();
	bag.x = "bx";
	bag[0] = "b0";

	const bytes:ByteArray = new ByteArray();
	bytes.writeByte(7);
	bytes.writeByte(8);

	return [
			"Array", array,
			"Array subclass", sub,
			"Vector.<int>", new <int>[30, 31],
			"Vector.<Object>", new <Object>["v0", null],
			"Vector.<Number> fixed", Vector.<Number>(new <Number>[1.5, 2.5]),
			"Dictionary", strong,
			"Dictionary weak", weak,
			"Object", plain,
			"dynamic class", bag,
			"sealed class", new Sealed(),
			"ByteArray", bytes,
			"String", "abc",
			"Number", 5,
			"Boolean", true,
			"Date", new Date(0),
			"Function", function(a:int, b:int):void
			{
			},
			"Class", Sealed,
			"XML", xml.copy(),
			"XMLList", xml.x.copy(),
			"Proxy", new Logged(),
			"null", null,
			"undefined", undefined
		];
}

// Left out: a ByteArray that avmshell grows to 2 GB, and what swf2es' XML
// does otherwise with a name that is 2^32-1 or a QName of another
// namespace or of any name, whatever the key's type.
function skipped(o:*, key:String):Boolean
{
	if (o is ByteArray)
	{
		return key == "2^31";
	}

	if (o is XML || o is XMLList)
	{
		return key == "2^32-1" || key == "QName other::x" || key == "QName *";
	}

	return false;
}

function walk():void
{
	const all:Array = receivers();
	for (var r:int = 0; r < all.length; r += 2)
	{
		const o:* = all[r + 1];
		if (o is Vector.<Number>)
		{
			o.fixed = true;
		}

		trace(all[r]);
		for (var k:int = 0; k < keys.length; k++)
		{
			const key:* = keys[k];
			if (skipped(o, keyNames[k]))
			{
				continue;
			}

			const before:String = attempt(function():*
				{
					return get (o, key);
				});
			const write:String = attempt(function():*
				{
					set (o, key, 40 + k);
					return "set";
				});
			const after:String = attempt(function():*
				{
					return get (o, key);
				});
			trace(" ", keyNames[k], "|", before, "|", write, "|", after);
		}

		if (o is Array || o is Dictionary || (o is Object && !(o is XML) && !(o is XMLList) && !(o is Proxy)))
		{
			const found:Array = [];
			for (var name:* in o)
			{
				found.push(describe(name));
			}

			trace("  names", found.sort().join(", "));
		}

		if (o is Array || o is ByteArray || o is Vector.<int> || o is Vector.<Object> || o is Vector.<Number>)
		{
			trace("  length", o.length);
		}
	}
}

walk();

// A Dictionary keys by the object: two with one string are two keys, and
// neither is the name their string is.
function identity():void
{
	const d:Dictionary = new Dictionary();
	set (d, object, "first");
	set (d, twin, "second");
	set (d, "1", "string");
	trace("identity", get (d, object), get (d, twin), get (d, 1), get (d, "1"), get (d, 1.0));
	set (d, 1, "number");
	trace("identity", get (d, object), get (d, twin), get (d, 1), get (d, "1"));
	set (d, object, undefined);
	trace("undefined value", get (d, object), object in d, get (d, twin));
	delete d[object];
	trace("deleted", get (d, object), object in d, get (d, twin));
	set (d, object, "again");
	trace("again", get (d, object));

	// An object as an Object's key is its string, and so the same as its twin's.
	const o:Object = {};
	set (o, object, "first");
	trace("by string", get (o, twin), get (o, 1), get (o, "1"));
}

identity();

// Other namespaces: a name that is not public is no index and no key.
function namespaces():void
{
	const bag:Bag = new Bag();
	const array:Array = [10, 11];
	const d:Dictionary = new Dictionary();
	d[object] = "dobject";
	trace("other", attempt(function():*
			{
				return getOther(bag, "x");
			}),
			attempt(function():*
				{
					return getOther(array, 1);
				}),
			attempt(function():*
				{
					return getOther(d, object);
				}),
			attempt(function():*
				{
					setOther(array, 1, "no");
					return array[1];
				}),
			attempt(function():*
				{
					setOther(d, object, "no");
					return d[object];
				}));
	trace("both", attempt(function():*
			{
				return getBoth(bag, "x");
			}),
			attempt(function():*
				{
					return getBoth(array, 1);
				}),
			attempt(function():*
				{
					return getBoth(d, object);
				}),
			attempt(function():*
				{
					return getBoth(new <int>[5, 6], 1);
				}),
			attempt(function():*
				{
					return getBoth(new <int>[5, 6], 2);
				}));
	trace("attribute", attempt(function():*
			{
				return getAttribute(xml, "b");
			}),
			attempt(function():*
				{
					return getAttribute(xml, 0);
				}),
			attempt(function():*
				{
					return getAttribute(xml, new QName("", "b"));
				}),
			attempt(function():*
				{
					return getAttribute(array, 1);
				}));
}

namespaces();

// The same in the script's own code, which avmshell interprets.
var o:* = [10, 11];
var k:* = 1;
trace("script", o[k]);
k = 1.5;
o[k] = "half";
trace("script", o[k], o["1.5"], o.length);
k = -1;
o[k] = "negative";
trace("script", o[k], o["-1"], o.length);
k = 4294967295;
o[k] = "top";
trace("script", o[k], o.length);
o = new Dictionary();
k = object;
o[k] = "by object";
trace("script", o[k], o[twin], o["1"], o[1]);
k = 1;
o[k] = "by number";
trace("script", o[k], o["1"], o[object]);
for (var each:* in o)
{
	trace("script name", describe(each));
}

o = new <int>[1, 2];
k = 2;
o[k] = 3;
trace("script", o[k], o.length);
k = 1.5;
trace("script", attempt(function():*
		{
			return o[k];
		}), attempt(function():*
		{
			o[k] = 1;
			return "set";
		}));
k = "1";
trace("script", o[k]);

// Interpreted, a Dictionary is asked for an object by a name of any
// namespace, and a Proxy is handed a number that is no index as a QName.
o = new Dictionary();
k = object;
o[k] = "by object";
trace("script other", attempt(function():*
		{
			return o.other::[k];
		}), o.other::[k]);
o.other::[k] = "by another name";
trace("script other", o[k]);
o = new Logged();
k = 1.5;
trace("script proxy", o[k]);
k = 2;
trace("script proxy", o[k]);
k = "2";
trace("script proxy", o[k]);
