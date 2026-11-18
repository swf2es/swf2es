// A ByteArray's bytes after compress and uncompress: read and written in
// place, grown past what the codec gave, and as the domain memory, read and
// written by the domain memory instructions and grown. Only round trips are
// compared, never the compressed bytes themselves.
import flash.utils.ByteArray;
import avmplus.Domain;
import avm2.intrinsics.memory.*;
// Bytes that do not compress much, from a seeded generator.
function noise(length:int):ByteArray
{
	var b:ByteArray = new ByteArray();
	var x:int = 7;
	for (var i:int = 0; i < length; i++)
	{
		x = (x * 69069 + 1) & 0x7fffffff;
		b.writeByte(x >> 16);
	}
	return b;
}
function same(a:ByteArray, b:ByteArray, length:int):Boolean
{
	if (a.length < length || b.length < length)
		return false;
	for (var i:int = 0; i < length; i++)
	{
		if (a[i] != b[i])
			return false;
	}
	return true;
}
var copy:ByteArray = noise(300);
for each (var algorithm:String in ["zlib", "deflate", "lzma"])
{
	var b:ByteArray = noise(300);
	b.compress(algorithm);
	var packed:uint = b.length;
	b.position = packed;
	b.writeInt(0x11223344);
	b.position = packed;
	trace(algorithm, "compressed, written past its end", b.length == packed + 4, b.readInt() == 0x11223344);
	b.length = packed;
	b.uncompress(algorithm);
	trace(algorithm, "back", b.length, b.position, same(b, copy, 300));
	trace(algorithm, "readInt", b.readInt() == ((copy[0] << 24) | (copy[1] << 16) | (copy[2] << 8) | copy[3]));
	b.position = 4;
	b.writeInt(-2);
	b.position = 4;
	trace(algorithm, "writeInt", b.readInt(), b.length, b[3] == copy[3], b[8] == copy[8]);
	b.position = 298;
	b.writeInt(0x01020304);
	trace(algorithm, "across the end", b.length, b[298], b[299], b[300], b[301]);
	b.length = 100000;
	b[99999] = 9;
	trace(algorithm, "grown", b.length, b[99999], b[50000], b[301], b[0] == copy[0], b[200] == copy[200]);
}
// The domain memory: the instructions read what compress and uncompress
// leave. Past its length avmshell's may read on into the rest of the buffer
// the codec allocated, where swf2es's ends, so only addresses within it are read.
var original:ByteArray = noise(4096);
var memory:ByteArray = noise(4096);
Domain.currentDomain.domainMemory = memory;
for each (algorithm in ["zlib", "deflate", "lzma"])
{
	memory.compress(algorithm);
	var end:int = memory.length;
	trace(algorithm, "memory compressed", Domain.currentDomain.domainMemory == memory, li8(0) == memory[0], li8(end - 1) == memory[end - 1]);
	memory.uncompress(algorithm);
	trace(algorithm, "memory back", memory.length, li8(0) == original[0], li8(4095) == original[4095], li32(100) == ((original[103] << 24) | (original[102] << 16) | (original[101] << 8) | original[100]), same(memory, original, 4096));
	si32(0x0a0b0c0d, 8);
	trace(algorithm, "memory written", memory[8], memory[11], li8(7) == original[7], li8(12) == original[12]);
	memory.position = 8;
	memory.writeBytes(original, 8, 4);
	memory.length = 8192;
	si8(5, 8000);
	trace(algorithm, "memory grown", li8(8000), memory[8000], li8(5000), li8(100) == original[100], same(memory, original, 4096));
	memory.length = 4096;
}
Domain.currentDomain.domainMemory = null;
