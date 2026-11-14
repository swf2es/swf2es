// Pure values on the stack, int, uint, Number and Boolean arithmetic,
// comparisons and conversions, which the compiler writes into the
// expression that reads them instead of a statement of their own: each
// must still be the value it had where it was pushed, when a local it
// reads is set before the read, when a call, getter, valueOf or exception
// comes between, and in the order avmshell evaluates the operands.

import avm2.intrinsics.memory.li32;
import avm2.intrinsics.memory.si32;
import avmplus.Domain;
import flash.utils.ByteArray;

var calls:Array = [];

function note(s:String, v:*):*
{
	calls.push(s);
	return v;
}

// A local read by a pending value, set before the value is read.
function setBetween(i:int, n:Number):void
{
	trace("set", i + 1, i = 5, i * 2, i);
	trace("set number", n * 2, n = 1.5, n + 0.25, n);
	var u:uint = 4294967295;
	trace("set uint", u + 1, u = 3, u - 4, u);
	var b:Boolean = true;
	trace("set boolean", !b, b = false, !b, b);
}

// Increments and compound assignments inside expressions.
function increments(a:int, x:Number):void
{
	trace("postfix", a + a+++a, a);
	trace("prefix", a * ++a - --a, a);
	var c:int = 3;
	c += c *= 2;
	trace("compound", c);
	var d:int = 10;
	d -= (d = 4) + d;
	trace("assign in operand", d);
	trace("number", x+++x, x-- * x, x);
	var arr:Array = [1, 2, 3];
	var k:int = 0;
	arr[k] += k++ * 10 + arr[k];
	trace("element", arr, k);
}

// Calls, getters and valueOf between a pending value and its read.
function between(i:int):void
{
	calls = [];
	var o:Object = {valueOf: function():Number
		{
			calls.push("valueOf");
			return 100;
		}
	};
	trace("valueOf", i + 1 + o + (i << 2), calls.join(","));
	calls = [];
	trace("calls", (i * 3) + note("a", 1) + (i - 1) + note("b", 2), calls.join(","));
	calls = [];
	var r:int = (i ^ 7) + int(note("c", 4)) * (i & 3);
	trace("int calls", r, calls.join(","));
	calls = [];
	trace("compare", (i < 3) == note("d", true), (i + 1 > 2) != note("e", false), calls.join(","));
}

class Counter
{
	private var _n:int = 0;
	public function get next():int
	{
		return ++_n;
	}
	public function get n():int
	{
		return _n;
	}
}

function getters(i:int):void
{
	var c:Counter = new Counter();
	trace("getters", (i + c.next) * (c.next - i), c.n);
	var j:int = i;
	trace("getters set", j + c.next, j = c.next, j - 1, c.n);
}

// An exception between a pending value and its read: the local it reads
// keeps the value it had, and the value is not seen.
function thrower(v:int):int
{
	if (v > 2)
	{
		throw new Error("thrown " + v);
	}

	return v;
}

function exceptions(i:int):void
{
	var j:int = i;
	try
	{
		j = (j + 1) * 2 + thrower(i) + (j - 1);
		trace("no throw", j);
	}
	catch (e:Error)
	{
		trace("caught", e.message, j);
	}

	var k:int = 1;
	try
	{
		k = k + thrower(k + i) + (k = 7);
	}
	catch (e:Error)
	{
		trace("caught k", e.message, k);
	}

	trace("after", j, k);
}

// Conditions and loops whose operands are pending values.
function loops(n:int):void
{
	var s:int = 0;
	var i:int = 0;
	while ((i + 1) * 2 < n * 3 && i - n != 5)
	{
		s = s + (i ^ (i >> 1)) | 0;
		i = (i + 1) | 0;
	}

	trace("loop", s, i);
	var u:uint = 0;
	for (var k:uint = 0; k < uint(n); k++)
	{
		u = u * 31 + (k >>> 1);
	}

	trace("uint loop", u);
	var t:Number = 0;
	for (var m:int = n; m > 0; m--)
	{
		t += m / 2 - (m % 3);
	}

	trace("number loop", t);
	switch ((n + 2) % 4)
	{
		case 0:
			trace("switch", 0);
			break;
		case 1:
			trace("switch", 1);
			break;
		default:
			trace("switch", "other");
	}
}

// Conversions and comparisons that write no statement of their own.
function conversions(i:int, d:Number, u:uint):void
{
	trace("int", int(d * 3), int(u + 1), uint(i - 10), Number(i) / 4);
	trace("boolean", Boolean(i - i), Boolean(d), !(i > 0), (i == 3) === (d > 1));
	trace("mixed", i + d, i * u, u - i, d % i, -i, ~i, -(i - u));
	trace("shifts", i << 30, i >> 1, -i >>> 1, u << 1, (u + 1) >>> 0);
}

// Domain memory read and written at addresses that are pending values,
// and the error of one out of range after a pending value.
function memory(base:int):void
{
	var bytes:ByteArray = new ByteArray();
	bytes.length = 1024;
	Domain.currentDomain.domainMemory = bytes;
	var p:int = base;
	si32(p * 3 + 1, p + 4);
	si32(li32(p + 4) * 2 + (p << 1), (p + 2) * 4);
	trace("memory", li32(p + 4), li32((p + 2) * 4), li32(p * 4 - (base - 4) * 4));
	var q:int = p;
	try
	{
		si32(q + 1, (q = 2000) * 4 + 1);
	}
	catch (e:RangeError)
	{
		trace("memory range", e.errorID, q, li32(p + 4));
	}

	try
	{
		q = li32((q + 1) * 1000) + (q = 9);
	}
	catch (e:RangeError)
	{
		trace("memory read range", e.errorID, q);
	}
}

setBetween(41, 2.5);
increments(3, 0.5);
between(2);
between(5);
getters(4);
exceptions(1);
exceptions(3);
loops(7);
loops(2);
conversions(3, 2.75, 4000000000);
conversions(-7, -0.5, 1);
memory(4);
