// The methods of String, int and Number called on values typed as them,
// which the compiler binds to the classes' own: a string walked by
// charCodeAt and by charAt, searched, and cut by substring, substr and
// slice, and numbers made strings. Each section traces what it sums, so
// that players are compared by their output.

// As mxmlc compiles by default: the methods are the AS3 ones of the
// classes, not their prototypes' functions.
use namespace AS3;

const N:int = 10000;

var text:String = "";
for (var k:int = 0; k < N; k++)
{
	text += String.fromCharCode(97 + k % 26);
}

// One flat string, not the tree the appends above left.
text = text.split("").join("");

function codes(s:String):int
{
	var sum:int = 0;
	var n:int = s.length;
	for (var i:int = 0; i < n; i++)
	{
		sum += s.charCodeAt(i);
	}

	return sum;
}

function chars(s:String):int
{
	var found:int = 0;
	var n:int = s.length;
	for (var i:int = 0; i < n; i++)
	{
		if (s.charAt(i) == "a")
		{
			found++;
		}
	}

	return found;
}

function finds(s:String):int
{
	var sum:int = 0;
	for (var i:int = 0; i < N; i++)
	{
		sum += s.indexOf("z", i & 15);
	}

	return sum;
}

function substrings(s:String):int
{
	var sum:int = 0;
	for (var i:int = 0; i < N; i++)
	{
		sum += s.substring(i, i + 3).length;
	}

	return sum;
}

function slices(s:String):int
{
	var sum:int = 0;
	for (var i:int = 0; i < N; i++)
	{
		sum += s.substr(i, 2).length + s.slice(i, i + 1).length;
	}

	return sum;
}

function intStrings(s:String):int
{
	var sum:int = 0;
	for (var i:int = 0; i < N; i++)
	{
		sum += i.toString().length;
	}

	return sum;
}

function numberStrings(s:String):int
{
	var sum:int = 0;
	var x:Number = 0.5;
	for (var i:int = 0; i < N; i++)
	{
		sum += x.toString().length;
		x += 1;
	}

	return sum;
}

function fixed(s:String):int
{
	var sum:int = 0;
	var x:Number = 0.25;
	for (var i:int = 0; i < N; i++)
	{
		sum += x.toFixed(1).length;
		x += 1;
	}

	return sum;
}

var checksum:Number = 0;

function bench(name:String, rounds:int, f:Function, x:String):void
{
	trace(name, f(x));
	for (var warm:int = 0; warm < rounds / 10; warm++)
	{
		checksum += f(x);
	}

	var started:Number = new Date().time;
	for (var j:int = 0; j < rounds; j++)
	{
		checksum += f(x);
	}

	trace("time:", name, new Date().time - started);
}

bench("charCodeAt", 1000, codes, text);
bench("charAt", 1000, chars, text);
bench("indexOf", 500, finds, text);
bench("substring", 500, substrings, text);
bench("substr-slice", 300, slices, text);
bench("int-toString", 300, intStrings, text);
bench("number-toString", 100, numberStrings, text);
bench("toFixed", 30, fixed, text);
trace("checked", checksum);
