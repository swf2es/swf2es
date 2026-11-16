// Domain memory that changes in the middle of a method which loads and
// stores in place: grown, shrunk, replaced or unset by a call, a setter,
// a ByteArray write, a getter, a valueOf a comparison or a store calls, or
// code that throws to a handler, in straight code and in loops. Every
// access after the change sees the memory as it is then.
import avmplus.Domain;
import flash.utils.ByteArray;
import avm2.intrinsics.memory.*;

var mem:ByteArray = new ByteArray();
mem.length = 1024;
Domain.currentDomain.domainMemory = mem;

function describe(e:*):String
{
	return e is Error ? String(e.errorID) : String(e);
}

function grow(to:int):void
{
	mem.length = to;
}

function swap(to:ByteArray):void
{
	Domain.currentDomain.domainMemory = to;
}

class Grower
{
	public function get size():int
	{
		mem.length = 8192;
		return mem.length;
	}

	public function valueOf():Number
	{
		mem.length = 16384;
		return 5;
	}
}

// Grown by a call, then stored and loaded past the old end.
function afterCall():String
{
	var at:int = 2044;
	var out:Array = [];
	try
	{
		si32(1, at);
	}
	catch (e:Error)
	{
		out.push("before " + describe(e));
	}
	grow(2048);
	si32(7, at);
	out.push(li32(at), li8(at), li16(at + 2));
	grow(1024);
	try
	{
		out.push(li32(at));
	}
	catch (e:Error)
	{
		out.push("shrunk " + describe(e));
	}
	return out.join(" ");
}
trace("call", afterCall());

// Replaced by a setter in the method itself and by a call.
function afterSetter():String
{
	var other:ByteArray = new ByteArray();
	other.length = 4096;
	var at:int = 4092;
	var far:int = 1000;
	var out:Array = [];
	si32(3, far);
	Domain.currentDomain.domainMemory = other;
	si32(4, at);
	out.push(li32(at));
	try
	{
		out.push(li32(far));
	}
	catch (e:Error)
	{
		out.push("other " + describe(e));
	}
	swap(mem);
	out.push(li32(far));
	try
	{
		out.push(other[4092], li32(at));
	}
	catch (e:Error)
	{
		out.push("back " + describe(e));
	}
	return out.join(" ");
}
trace("setter", afterSetter());

// Grown by a ByteArray write past its end.
function afterWrite():String
{
	var at:int = 1100;
	mem.position = 1100;
	mem.writeInt(0x01020304);
	var out:Array = [mem.length, li8(at), li8(at + 3)];
	si8(9, at + 3);
	out.push(mem[1103]);
	mem.length = 1024;
	return out.join(" ");
}
trace("write", afterWrite());

// Grown by a getter, and by valueOf called for a comparison and for a store's value.
function afterGetterAndValueOf(g:Grower, o:*):String
{
	var at:int = 8000;
	var out:Array = [g.size];
	si32(21, at);
	out.push(li32(at));
	var far:int = 16000;
	if (o < 6)
	{
		si32(22, far);
		out.push(li32(far), mem.length);
	}
	mem.length = 1024;
	si32(o, 10);
	out.push(mem.length, li32(10));
	si32(23, far);
	out.push(li32(far));
	mem.length = 1024;
	return out.join(" ");
}
trace("getter", afterGetterAndValueOf(new Grower(), new Grower()));

// An address whose valueOf grows the memory, loaded and stored through the runtime.
function untypedAddress(o:*):String
{
	var out:Array = [];
	si32(31, o);
	out.push(li32(o), mem.length);
	var at:int = 16380;
	si32(32, at);
	out.push(li32(at));
	mem.length = 1024;
	return out.join(" ");
}
trace("address", untypedAddress(new Grower()));

// Grown, then a throw, in code a handler covers: the handler sees the grown memory.
function inHandler():String
{
	var at:int = 4000;
	var out:Array = [];
	try
	{
		grow(4096);
		throw new Error("thrown", 7);
	}
	catch (e:Error)
	{
		si32(41, at);
		out.push(describe(e), li32(at));
	}
	mem.length = 1024;
	try
	{
		si32(42, at);
	}
	catch (e:Error)
	{
		out.push("after " + describe(e));
	}
	return out.join(" ");
}
trace("handler", inHandler());

// In a loop: each turn grows the memory and writes at its new end, then
// a turn shrinks it again and the next access past the end throws.
function inLoop():String
{
	var sum:int = 0;
	var at:int = 0;
	for (var n:int = 1; n <= 8; n++)
	{
		at = 1024 * n - 4;
		si32(n, at);
		sum += li32(at);
		grow(1024 * (n + 1));
	}
	var out:Array = [sum, mem.length, li32(1020), li32(8188)];
	for (n = 8; n > 0; n--)
	{
		at = 1024 * n - 4;
		try
		{
			out.push(li32(at));
		}
		catch (e:Error)
		{
			out.push(n + ":" + describe(e));
		}
		if (n == 5)
		{
			grow(2048);
		}
	}
	mem.length = 1024;
	return out.join(" ");
}
trace("loop", inLoop());

// Unset: the domain memory is a scratch memory again until set.
function unset():String
{
	var out:Array = [];
	var at:int = 1020;
	si32(51, at);
	Domain.currentDomain.domainMemory = null;
	try
	{
		out.push(li32(at), li32(0));
	}
	catch (e:Error)
	{
		out.push("unset " + describe(e));
	}
	try
	{
		si32(52, at);
		out.push(li32(at));
	}
	catch (e:Error)
	{
		out.push("unset store " + describe(e));
	}
	Domain.currentDomain.domainMemory = mem;
	out.push(li32(at));
	return out.join(" ");
}
trace("unset", unset());
