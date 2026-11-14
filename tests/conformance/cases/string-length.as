// A String's length where the code knows it has a String, which it reads
// in place, and its methods and a Number's and a Boolean's called by their
// classes' prototypes: of a local, a parameter, a method's result and a
// Vector.<String>'s element, read in and past its range, growable and
// fixed; of null, which is a TypeError; of strings of other characters
// than ASCII; through references typed Object and *, which look the name
// up; and with a length the prototype is given, which a String's own hides.
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

function lengthOf(s:String):int
{
	return s.length;
}

function total(v:Vector.<String>):int
{
	var sum:int = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		sum += v[i].length;
	}

	return sum;
}

function totalToLength(v:Vector.<String>):int
{
	var sum:int = 0;
	for (var i:int = 0; i < v.length; i++)
	{
		sum += v[i].length;
	}

	return sum;
}

function untypedTotal(u:*):Number
{
	var sum:Number = 0;
	for (var i:int = 0; i < u.length; i++)
	{
		sum += u[i].length;
	}

	return sum;
}

var empty:String = "";
var word:String = "swf2es";
var none:String = null;
var wide:String = "aä€😀";
trace(empty.length, word.length, wide.length, "literal".length);
trace(lengthOf(""), lengthOf("abc"), lengthOf(wide), lengthOf(String(12345)));
trace((word + wide).length, word.substr(1, 3).length, word.toUpperCase().length);
trace(word.charAt(9).length, String.fromCharCode(65, 66).length, (1.5).toFixed(3).length);
trace(typeof word.length, word.length is int, word.length + 0.5, -word.length, word.length / 4);
probe("null local", function():*
	{
		return none.length;
	});
probe("null argument", function():*
	{
		return lengthOf(null);
	});
probe("undefined argument", function():*
	{
		return lengthOf(undefined);
	});
probe("number argument", function():*
	{
		var f:Function = lengthOf;
		return f(1234);
	});
probe("object argument", function():*
	{
		var f:Function = lengthOf;
		return f({toString: function():String
				{
					return "seven77";
				}
			});
	});

var names:Vector.<String> = new Vector.<String>();
names.push("one", "three", "", wide);
var fixed:Vector.<String> = new Vector.<String>(3, true);
fixed[0] = "first";
fixed[2] = "third";
trace(total(names), totalToLength(names), untypedTotal(names), names[1].length);
probe("fixed total", function():*
	{
		return total(fixed);
	});
probe("fixed element", function():*
	{
		return fixed[0].length + fixed[2].length;
	});
probe("fixed null element", function():*
	{
		return fixed[1].length;
	});
probe("fixed null element untyped", function():*
	{
		var u:* = fixed;
		return u[1].length;
	});
probe("null element", function():*
	{
		names[2] = null;
		return total(names);
	});
probe("null element to length", function():*
	{
		return totalToLength(names);
	});
probe("null element untyped", function():*
	{
		return untypedTotal(names);
	});
probe("past the end", function():*
	{
		return names[4].length;
	});
probe("past the end fixed", function():*
	{
		return fixed[3].length;
	});
probe("negative", function():*
	{
		var i:int = -1;
		return names[i].length;
	});
probe("fractional", function():*
	{
		var x:Number = 1.5;
		return names[x].length;
	});
probe("past the end untyped", function():*
	{
		var u:* = names;
		return u[4].length;
	});
probe("null vector", function():*
	{
		var v:Vector.<String> = null;
		return v[0].length;
	});
probe("written", function():*
	{
		names[2] = "filled";
		names[4] = "appended";
		return total(names);
	});
probe("written number", function():*
	{
		var u:* = names;
		u[0] = 123456;
		return names[0].length;
	});
probe("popped", function():*
	{
		return names.pop().length;
	});
probe("popped empty", function():*
	{
		var v:Vector.<String> = new Vector.<String>();
		return v.pop().length;
	});

var array:Array = ["ab", "cde", null, 12];
probe("array element", function():*
	{
		return array[0].length + array[1].length;
	});
probe("array null element", function():*
	{
		return array[2].length;
	});
probe("array number element", function():*
	{
		return array[3].length;
	});
probe("array hole", function():*
	{
		return array[9].length;
	});
probe("array element as String", function():*
	{
		var s:String = array[3];
		return s.length;
	});

var o:Object = word;
var u:* = word;
trace(o.length, u.length, o["length"], u["length"], Object(word).length);
String.prototype.length = 99;
String.prototype.size = 7;
trace(word.length, o.length, u.length, o.size, u.size);
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
trace(word.hasOwnProperty("length"), "length" in o, word.length);

// The methods of the primitives, called on values typed as them.
var n:Number = 255.5;
var i:int = -42;
var k:uint = 4000000000;
var b:Boolean = true;
trace(word.charAt(0), word.charCodeAt(1), word.indexOf("2"), word.slice(1, 4), word.split("f"));
trace(wide.charCodeAt(2), wide.charCodeAt(9), wide.toUpperCase().length, wide.substring(1, 3).length);
trace(n.toString(16), n.toFixed(2), n.toPrecision(2), n.valueOf(), n.toExponential(1));
trace(i.toString(), i.toString(2), i.valueOf(), k.toString(36), k.valueOf(), k.toFixed(1));
trace(b.toString(), b.valueOf(), (!b).toString(), b.toString().length);
probe("null charAt", function():*
	{
		return none.charAt(0);
	});
probe("null toUpperCase", function():*
	{
		return none.toUpperCase();
	});
probe("radix", function():*
	{
		return n.toString(99);
	});
probe("digits", function():*
	{
		return n.toFixed(-1);
	});

function inAs3():void
{
	use namespace AS3;
	trace(word.length, word.charAt(1), word.charCodeAt(2), word.indexOf("e"), word.substr(-2).length);
	trace(n.toString(2).length, n.toFixed(1), i.toString(16), k.toString(), b.toString().length);
	probe("null charAt AS3", function():*
		{
			return none.charAt(0);
		});
	probe("null length AS3", function():*
		{
			return none.length;
		});
	probe("null element AS3", function():*
		{
			return fixed[1].charAt(0);
		});
	var sum:int = 0;
	for (var j:int = 0; j < word.length; j++)
	{
		sum += word.charCodeAt(j) + word.charAt(j).length;
	}

	trace(sum);
}

inAs3();
