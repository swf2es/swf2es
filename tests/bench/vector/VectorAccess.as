// Indexed access to Vectors of int, Number, String, Object and a class,
// beside the same work on Arrays: reads in a loop to a hoisted length and to
// v.length, writes, read-modify-write, fixed and growable Vectors, growth by
// index, push and pop, and access through an untyped reference. Each section
// traces what it sums, so that players are compared by their output; the
// writes come after the reads of the same elements, so the sums read what
// was built.

// As mxmlc compiles by default: push and pop are the AS3 methods of Vector
// and Array, not their prototypes' functions.
use namespace AS3;

class Item
{
	public var x:int;

	public function Item(x:int)
	{
		this.x = x;
	}
}

const N:int = 10000;

var marker:Object = {};
var ints:Vector.<int> = new Vector.<int>();
var fixedInts:Vector.<int> = new Vector.<int>(N, true);
var numbers:Vector.<Number> = new Vector.<Number>();
var fixedNumbers:Vector.<Number> = new Vector.<Number>(N, true);
var strings:Vector.<String> = new Vector.<String>();
var objects:Vector.<Object> = new Vector.<Object>();
var items:Vector.<Item> = new Vector.<Item>();
var intArray:Array = [];
var numberArray:Array = [];
var stringArray:Array = [];
var objectArray:Array = [];

for (var k:int = 0; k < N; k++)
{
	ints.push(k);
	fixedInts[k] = k;
	numbers.push(k + 0.5);
	fixedNumbers[k] = k + 0.5;
	strings.push("s" + k);
	objects.push(k % 7 == 0 ? marker : {});
	items.push(new Item(k));
	intArray.push(k);
	numberArray.push(k + 0.5);
	stringArray.push("s" + k);
	objectArray.push(objects[k]);
}

function intRead(v:Vector.<int>):int
{
	var sum:int = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		sum += v[i];
	}

	return sum;
}

function intReadLength(v:Vector.<int>):int
{
	var sum:int = 0;
	for (var i:int = 0; i < v.length; i++)
	{
		sum += v[i];
	}

	return sum;
}

function intWrite(v:Vector.<int>):int
{
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v[i] = i;
	}

	return v[n - 1];
}

function intRmw(v:Vector.<int>):int
{
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v[i] += 3;
	}

	return v[n - 1];
}

function intAppend(v:Vector.<int>):int
{
	var n:int = v.length;
	v.length = 0;
	for (var i:int = 0; i < n; i++)
	{
		v[i] = i;
	}

	return v.length;
}

function intPushPop(v:Vector.<int>):int
{
	var sum:int = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v.push(i);
	}

	for (var j:int = 0; j < n; j++)
	{
		sum += v.pop();
	}

	return sum;
}

function numberRead(v:Vector.<Number>):Number
{
	var sum:Number = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		sum += v[i];
	}

	return sum;
}

function numberReadLength(v:Vector.<Number>):Number
{
	var sum:Number = 0;
	for (var i:int = 0; i < v.length; i++)
	{
		sum += v[i];
	}

	return sum;
}

function numberWrite(v:Vector.<Number>):Number
{
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v[i] = i + 0.25;
	}

	return v[n - 1];
}

function numberRmw(v:Vector.<Number>):Number
{
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v[i] += 0.5;
	}

	return v[n - 1];
}

function numberAppend(v:Vector.<Number>):Number
{
	var n:int = v.length;
	v.length = 0;
	for (var i:int = 0; i < n; i++)
	{
		v[i] = i + 0.5;
	}

	return v.length;
}

function numberPushPop(v:Vector.<Number>):Number
{
	var sum:Number = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v.push(i + 0.5);
	}

	for (var j:int = 0; j < n; j++)
	{
		sum += v.pop();
	}

	return sum;
}

function stringRead(v:Vector.<String>):int
{
	var sum:int = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		sum += v[i].length;
	}

	return sum;
}

function stringReadLength(v:Vector.<String>):int
{
	var sum:int = 0;
	for (var i:int = 0; i < v.length; i++)
	{
		sum += v[i].length;
	}

	return sum;
}

function stringWrite(v:Vector.<String>):int
{
	var s:String = "w";
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v[i] = s;
	}

	return v[n - 1].length;
}

function stringPushPop(v:Vector.<String>):int
{
	var s:String = "p";
	var sum:int = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v.push(s);
	}

	for (var j:int = 0; j < n; j++)
	{
		sum += v.pop().length;
	}

	return sum;
}

function objectRead(v:Vector.<Object>):int
{
	var found:int = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		if (v[i] === marker)
		{
			found++;
		}
	}

	return found;
}

function objectReadLength(v:Vector.<Object>):int
{
	var found:int = 0;
	for (var i:int = 0; i < v.length; i++)
	{
		if (v[i] === marker)
		{
			found++;
		}
	}

	return found;
}

function objectWrite(v:Vector.<Object>):int
{
	var o:Object = marker;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v[i] = o;
	}

	return v[n - 1] === marker ? 1 : 0;
}

function objectPushPop(v:Vector.<Object>):int
{
	var o:Object = marker;
	var found:int = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v.push(o);
	}

	for (var j:int = 0; j < n; j++)
	{
		if (v.pop() === marker)
		{
			found++;
		}
	}

	return found;
}

function itemRead(v:Vector.<Item>):int
{
	var sum:int = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		sum += v[i].x;
	}

	return sum;
}

function itemReadLength(v:Vector.<Item>):int
{
	var sum:int = 0;
	for (var i:int = 0; i < v.length; i++)
	{
		sum += v[i].x;
	}

	return sum;
}

function itemWrite(v:Vector.<Item>):int
{
	var item:Item = v[0];
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v[i] = item;
	}

	return v[n - 1].x;
}

function itemPushPop(v:Vector.<Item>):int
{
	var item:Item = v[0];
	var sum:int = 0;
	var n:int = v.length;
	for (var i:int = 0; i < n; i++)
	{
		v.push(item);
	}

	for (var j:int = 0; j < n; j++)
	{
		sum += v.pop().x;
	}

	return sum;
}

// The same reads and writes where the code does not know it has a Vector.

function untypedRead(u:*):Number
{
	var sum:Number = 0;
	var n:int = u.length;
	for (var i:int = 0; i < n; i++)
	{
		sum += u[i];
	}

	return sum;
}

function untypedFind(u:*):int
{
	var found:int = 0;
	var n:int = u.length;
	for (var i:int = 0; i < n; i++)
	{
		if (u[i] === marker)
		{
			found++;
		}
	}

	return found;
}

function untypedWrite(u:*):Number
{
	var n:int = u.length;
	for (var i:int = 0; i < n; i++)
	{
		u[i] = i;
	}

	return u[n - 1];
}

// Arrays of the same contents.

function arrayIntRead(a:Array):int
{
	var sum:int = 0;
	var n:int = a.length;
	for (var i:int = 0; i < n; i++)
	{
		sum += a[i];
	}

	return sum;
}

function arrayIntReadLength(a:Array):int
{
	var sum:int = 0;
	for (var i:int = 0; i < a.length; i++)
	{
		sum += a[i];
	}

	return sum;
}

function arrayIntWrite(a:Array):int
{
	var n:int = a.length;
	for (var i:int = 0; i < n; i++)
	{
		a[i] = i;
	}

	return a[n - 1];
}

function arrayIntRmw(a:Array):int
{
	var n:int = a.length;
	for (var i:int = 0; i < n; i++)
	{
		a[i] += 3;
	}

	return a[n - 1];
}

function arrayIntPushPop(a:Array):int
{
	var sum:int = 0;
	var n:int = a.length;
	for (var i:int = 0; i < n; i++)
	{
		a.push(i);
	}

	for (var j:int = 0; j < n; j++)
	{
		sum += a.pop();
	}

	return sum;
}

function arrayNumberRead(a:Array):Number
{
	var sum:Number = 0;
	var n:int = a.length;
	for (var i:int = 0; i < n; i++)
	{
		sum += a[i];
	}

	return sum;
}

function arrayNumberWrite(a:Array):Number
{
	var n:int = a.length;
	for (var i:int = 0; i < n; i++)
	{
		a[i] = i + 0.25;
	}

	return a[n - 1];
}

function arrayNumberRmw(a:Array):Number
{
	var n:int = a.length;
	for (var i:int = 0; i < n; i++)
	{
		a[i] += 0.5;
	}

	return a[n - 1];
}

function arrayStringRead(a:Array):int
{
	var sum:int = 0;
	var n:int = a.length;
	for (var i:int = 0; i < n; i++)
	{
		sum += a[i].length;
	}

	return sum;
}

function arrayObjectRead(a:Array):int
{
	var found:int = 0;
	var n:int = a.length;
	for (var i:int = 0; i < n; i++)
	{
		if (a[i] === marker)
		{
			found++;
		}
	}

	return found;
}

function arrayObjectWrite(a:Array):int
{
	var o:Object = marker;
	var n:int = a.length;
	for (var i:int = 0; i < n; i++)
	{
		a[i] = o;
	}

	return a[n - 1] === marker ? 1 : 0;
}

var checksum:Number = 0;

function bench(name:String, rounds:int, f:Function, x:*):void
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

bench("int-read", 6000, intRead, ints);
bench("int-read-length", 6000, intReadLength, ints);
bench("int-read-fixed", 6000, intRead, fixedInts);
bench("int-read-untyped", 1000, untypedRead, ints);
bench("int-rmw", 5000, intRmw, ints);
bench("int-rmw-fixed", 5000, intRmw, fixedInts);
bench("int-write", 6000, intWrite, ints);
bench("int-write-fixed", 6000, intWrite, fixedInts);
bench("int-write-untyped", 1000, untypedWrite, ints);
bench("int-append", 600, intAppend, ints);
bench("int-push-pop", 400, intPushPop, ints);

bench("number-read", 5000, numberRead, numbers);
bench("number-read-length", 5000, numberReadLength, numbers);
bench("number-read-fixed", 5000, numberRead, fixedNumbers);
bench("number-read-untyped", 200, untypedRead, numbers);
bench("number-rmw", 5000, numberRmw, numbers);
bench("number-rmw-fixed", 5000, numberRmw, fixedNumbers);
bench("number-write", 5000, numberWrite, numbers);
bench("number-write-fixed", 5000, numberWrite, fixedNumbers);
bench("number-write-untyped", 1000, untypedWrite, numbers);
bench("number-append", 600, numberAppend, numbers);
bench("number-push-pop", 400, numberPushPop, numbers);

bench("string-read", 1000, stringRead, strings);
bench("string-read-length", 1000, stringReadLength, strings);
bench("string-write", 2000, stringWrite, strings);
bench("string-push-pop", 300, stringPushPop, strings);

bench("object-read", 1500, objectRead, objects);
bench("object-read-length", 1500, objectReadLength, objects);
bench("object-read-untyped", 1000, untypedFind, objects);
bench("object-write", 2000, objectWrite, objects);
bench("object-push-pop", 400, objectPushPop, objects);

bench("item-read", 2000, itemRead, items);
bench("item-read-length", 2000, itemReadLength, items);
bench("item-write", 2000, itemWrite, items);
bench("item-push-pop", 400, itemPushPop, items);

bench("array-int-read", 1200, arrayIntRead, intArray);
bench("array-int-read-length", 1000, arrayIntReadLength, intArray);
bench("array-int-read-untyped", 1000, untypedRead, intArray);
bench("array-int-rmw", 1000, arrayIntRmw, intArray);
bench("array-int-write", 1000, arrayIntWrite, intArray);
bench("array-int-push-pop", 400, arrayIntPushPop, intArray);
bench("array-number-read", 400, arrayNumberRead, numberArray);
bench("array-number-rmw", 400, arrayNumberRmw, numberArray);
bench("array-number-write", 400, arrayNumberWrite, numberArray);
bench("array-string-read", 1000, arrayStringRead, stringArray);
bench("array-object-read", 1000, arrayObjectRead, objectArray);
bench("array-object-write", 1000, arrayObjectWrite, objectArray);
trace("checked", checksum);
