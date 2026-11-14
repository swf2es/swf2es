// `in` a Dictionary with a key it does not have, as in_operator: an object
// key is looked for itself, then as its string on the prototypes, not on
// the Dictionary's own names, so its toString runs on a miss, never on a
// hit; any other key, a Namespace's uri included, is a name, the
// Dictionary's own or its prototypes'. A weak Dictionary's misses are the
// same, before and after a key let go of is collected.
import avmplus.System;
import flash.utils.Dictionary;

class Named
{
	public var name:String;
	public function Named(name:String)
	{
		this.name = name;
	}
	public function toString():String
	{
		trace("  toString", name);
		return name;
	}
}

class Plain
{
}

dynamic class Open
{
}

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

for each (var weak:Boolean in [false, true])
{
	trace(weak ? "weak" : "strong");
	var d:Dictionary = new Dictionary(weak);
	var held:Object = {};
	var heldNamed:Named = new Named("held");
	d[held] = 1;
	d[heldNamed] = 2;
	d["own"] = 3;
	d[7] = 4;

	// Hits: no toString.
	probe("held", function():*
		{
			return held in d;
		});
	probe("held named", function():*
		{
			return heldNamed in d;
		});

	// Object keys missing: their strings are looked for on the prototypes only.
	probe("object", function():*
		{
			return {} in d;
		});
	probe("array", function():*
		{
			return [] in d;
		});
	probe("array toString", function():*
		{
			return ["toString"] in d;
		});
	probe("function", function():*
		{
			return function():void
			{
			}
			in d;
		});
	probe("plain", function():*
		{
			return new Plain() in d;
		});
	probe("open", function():*
		{
			return new Open() in d;
		});
	probe("dictionary", function():*
		{
			return new Dictionary() in d;
		});
	probe("d itself", function():*
		{
			return d in d;
		});
	probe("named nothing", function():*
		{
			return new Named("nothing") in d;
		});
	probe("named toString", function():*
		{
			return new Named("toString") in d;
		});
	probe("named constructor", function():*
		{
			return new Named("constructor") in d;
		});
	probe("named hasOwnProperty", function():*
		{
			return new Named("hasOwnProperty") in d;
		});
	probe("named valueOf", function():*
		{
			return new Named("valueOf") in d;
		});
	probe("named own", function():*
		{
			return new Named("own") in d;
		});
	probe("named 7", function():*
		{
			return new Named("7") in d;
		});
	probe("named empty", function():*
		{
			return new Named("") in d;
		});
	probe("dynamic toString", function():*
		{
			return {toString: function():String
				{
					return "propertyIsEnumerable";
				}
			} in d;
		});
	probe("toString not a function", function():*
		{
			return {toString: 3} in d;
		});
	probe("toString an object", function():*
		{
			return {toString: function():Object
				{
					return {};
				}, valueOf: function():String
				{
					return "valueOf";
				}
			} in d;
		});

	// On Dictionary.prototype, and on Object.prototype, while they are there.
	Dictionary.prototype.extra = 1;
	Object.prototype.objectExtra = 1;
	probe("named extra", function():*
		{
			return new Named("extra") in d;
		});
	probe("named objectExtra", function():*
		{
			return new Named("objectExtra") in d;
		});
	Object.prototype["[object Object]"] = 1;
	probe("object on prototype", function():*
		{
			return {} in d;
		});
	probe("held on prototype", function():*
		{
			return held in d;
		});
	delete Dictionary.prototype.extra;
	delete Object.prototype.objectExtra;
	delete Object.prototype["[object Object]"];
	probe("named extra gone", function():*
		{
			return new Named("extra") in d;
		});
	probe("object gone", function():*
		{
			return {} in d;
		});

	// Names: the Dictionary's own, then its prototypes'.
	probe("own", function():*
		{
			return "own" in d;
		});
	probe("toString", function():*
		{
			return "toString" in d;
		});
	probe("constructor", function():*
		{
			return "constructor" in d;
		});
	probe("hasOwnProperty", function():*
		{
			return "hasOwnProperty" in d;
		});
	probe("missing", function():*
		{
			return "missing" in d;
		});
	probe("[object Object]", function():*
		{
			return "[object Object]" in d;
		});
	probe("[object Named]", function():*
		{
			return "[object Named]" in d;
		});
	probe("held", function():*
		{
			return "held" in d;
		});
	probe("7", function():*
		{
			return 7 in d;
		});
	probe("'7'", function():*
		{
			return "7" in d;
		});
	probe("8", function():*
		{
			return 8 in d;
		});
	probe("-1", function():*
		{
			return -1 in d;
		});
	probe("1.5", function():*
		{
			return 1.5 in d;
		});
	probe("4294967295", function():*
		{
			return 4294967295 in d;
		});
	probe("true", function():*
		{
			return true in d;
		});
	probe("null", function():*
		{
			return null in d;
		});
	probe("undefined", function():*
		{
			return undefined in d;
		});
	probe("NaN", function():*
		{
			return NaN in d;
		});
	d[null] = 5;
	d[undefined] = 6;
	d[NaN] = 7;
	d[true] = 8;
	probe("null set", function():*
		{
			return [null in d, "null" in d].join(",");
		});
	probe("undefined set", function():*
		{
			return [undefined in d, "undefined" in d].join(",");
		});
	probe("NaN set", function():*
		{
			return [NaN in d, "NaN" in d].join(",");
		});
	probe("true set", function():*
		{
			return [true in d, "true" in d].join(",");
		});

	// A Namespace is a name, its uri; a QName is an object key, itself, then its string.
	d["http://x"] = 10;
	d["http://x::y"] = 11;
	probe("namespace", function():*
		{
			return [new Namespace("http://x") in d, new Namespace("http://z") in d].join(",");
		});
	probe("qname", function():*
		{
			return new QName("http://x", "y") in d;
		});
	probe("qname on prototype", function():*
		{
			Object.prototype["http://x::y"] = 1;
			var r:Boolean = new QName("http://x", "y") in d;
			delete Object.prototype["http://x::y"];
			return r;
		});

	// A key deleted, and one let go and collected, is not there.
	delete d[held];
	probe("deleted", function():*
		{
			return held in d;
		});
	probe("deleted named", function():*
		{
			return delete d[heldNamed] && !(heldNamed in d);
		});
	(function():void
		{
			var gone:Object = {};
			d[gone] = 9;
		})();
	System.forceFullCollection();
	probe("after collection", function():*
		{
			return [ {} in d, "[object Object]" in d].join(",");
		});
}
