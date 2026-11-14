// `length` read on a value typed * or Object, where the code tells a
// string, whose length it reads in place, from anything else, which the
// runtime looks the name up on: strings, Arrays, Vectors, objects with a
// length of their own, a getter's, functions, classes, XML, null and
// undefined, numbers and Booleans; the value an expression's, evaluated
// once; a length the String prototype is given, which a string's own
// hides; and names that are not the public length, which stay lookups.
package
{
	public class Sized
	{
		public var length:int = 7;
	}
}
package
{
	public class Measured
	{
		public static var asked:int = 0;
		public function get length():String
		{
			asked++;
			return "measured";
		}
	}
}
package
{
	public namespace other = "urn:other";
}
package
{
	public dynamic class Named
	{
		other var length:String = "other's";
	}
}
function probe(name:String, f:Function):void
{
	try
	{
		trace(name, f());
	}
	catch (e:Error)
	{
		trace(name, e.errorID, e);
	}
}

function lengthOf(u:*):*
{
	return u.length;
}

function lengthOfObject(o:Object):*
{
	return o.length;
}

function total(a:Array):Number
{
	var sum:Number = 0;
	for (var i:int = 0; i < a.length; i++)
	{
		sum += a[i].length;
	}

	return sum;
}

var calls:int = 0;
function next(a:Array):*
{
	return a[calls++];
}

var wide:String = "aä€😀";
var vector:Vector.<int> = new <int>[1, 2, 3];
var values:Array = [
		"", "swf2es", wide, [1, 2], [], vector, new Vector.<String>(4, true), {length: "own"}, {},
		new Sized(), new Measured(), function(a:int, b:int):void
		{
		}, Sized, new Named(), 5, 1.5, true, NaN,
		<a><length>child</length><b/></a>, <a/>, new XMLList("<x/><y/>"), new QName("urn:q", "local"), new Date(0)
	];
for (var i:int = 0; i < values.length; i++)
{
	probe("* " + i, function():*
		{
			return lengthOf(values[i]);
		});
	probe("Object " + i, function():*
		{
			return lengthOfObject(values[i]);
		});
}

trace(Measured.asked);
probe("null", function():*
	{
		return lengthOf(null);
	});
probe("undefined", function():*
	{
		return lengthOf(undefined);
	});
probe("null Object", function():*
	{
		return lengthOfObject(null);
	});
probe("undefined Object", function():*
	{
		return lengthOfObject(undefined);
	});
probe("total", function():*
	{
		return total(["ab", "", wide, [1, 2, 3], vector]);
	});
probe("total with null", function():*
	{
		return total(["ab", null]);
	});
probe("total with a hole", function():*
	{
		var a:Array = ["ab"];
		a[2] = "c";
		return total(a);
	});
probe("total with a number", function():*
	{
		return total(["ab", 3]);
	});

// The value is an expression's: evaluated once, whatever it gives.
var mixed:Array = ["one", [1, 2], "three", null];
trace(next(mixed).length, next(mixed).length, next(mixed).length, calls);
probe("next is null", function():*
	{
		return next(mixed).length;
	});
trace(calls, (calls > 2 ? "yes" : [1]).length, (calls < 2 ? "yes" : [1]).length);
trace(mixed[0].length + mixed[2].length, mixed[0].length.toString(), typeof mixed[0].length, mixed[0].length is int);
probe("length of a length", function():*
	{
		return mixed[0].length.length;
	});
var o:Object = "object";
var u:* = "untyped";
trace(o.length, u.length, o["length"], u["length"], Object(wide).length, o.length + u.length, -u.length);
var key:String = "length";
var index:* = "length";
trace(o[key], u[key], o[index], u[index], mixed[key], mixed[index]);

// With a String's prototype given a length, and a size.
String.prototype.length = 99;
String.prototype.size = 7;
Object.prototype.length = "inherited";
trace(o.length, u.length, lengthOf("abc"), lengthOfObject(""), total(["ab", "c"]), o.size, u.size);
trace(lengthOf({}), lengthOf(5), lengthOf(true), lengthOf(new Named()), lengthOf([1]), lengthOf(vector));
delete Object.prototype.length;
probe("set", function():*
	{
		o.length = 2;
		return o.length;
	});
probe("set untyped", function():*
	{
		u.length = 2;
		return u.length;
	});
probe("delete", function():*
	{
		return delete u.length;
	});
trace("length" in o, o.hasOwnProperty("length"), u.propertyIsEnumerable("length"));

// Names that are not the public length.
var named:* = new Named();
var xml:* = <a length="attribute"><length>child</length></a>;
trace(named.other::length, named.length, xml.@length, xml.length, xml.length());
probe("other's of a string", function():*
	{
		return u.other::length;
	});
probe("AS3's of a string", function():*
	{
		return u.AS3::length;
	});
probe("descendants of a string", function():*
	{
		return u..length;
	});
probe("called", function():*
	{
		return u.length();
	});
with (u)
{
	trace(length);
}

with (mixed)
{
	trace(length);
}

function inAs3():void
{
	use namespace AS3;
	use namespace other;
	trace(o.length, u.length, lengthOf("four"), named.length, mixed.length, mixed[0].length, values[3].length);
	probe("null in AS3", function():*
		{
			var none:* = null;
			return none.length;
		});
}

inAs3();
