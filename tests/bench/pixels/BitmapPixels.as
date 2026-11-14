// A BitmapData's pixels set and read whole, a frame's worth at a time, as
// a game that draws in software does each frame: setPixels from a ByteArray
// in either byte order, setVector, getPixels and getVector, on an opaque
// and a transparent 640 by 480 bitmap. Each section traces a sum of what it
// set or read, so that players are compared by their output.

import flash.display.BitmapData;
import flash.geom.Rectangle;
import flash.utils.ByteArray;
import flash.utils.Endian;

const W:int = 640;
const H:int = 480;

var rect:Rectangle = new Rectangle(0, 0, W, H);
var opaque:BitmapData = new BitmapData(W, H, false, 0);
var transparent:BitmapData = new BitmapData(W, H, true, 0);
var big:ByteArray = new ByteArray();
var little:ByteArray = new ByteArray();
little.endian = Endian.LITTLE_ENDIAN;
var vector:Vector.<uint> = new Vector.<uint>(W * H, true);
for (var k:int = 0; k < W * H; k++)
{
	// Every alpha, some clear: a transparent bitmap premultiplies each.
	var argb:uint = ((k * 7) & 0xff) << 24 | (k * 2654435761) & 0xffffff;
	big.writeUnsignedInt(argb);
	little.writeUnsignedInt(argb);
	vector[k] = argb;
}

function sample(bd:BitmapData):Number
{
	return bd.getPixel32(1, 0) + bd.getPixel32(W - 1, H / 2) + bd.getPixel32(W / 3, H - 1);
}

function setBig(bd:BitmapData):Number
{
	big.position = 0;
	bd.setPixels(rect, big);
	return big.position + sample(bd);
}

function setLittle(bd:BitmapData):Number
{
	little.position = 0;
	bd.setPixels(rect, little);
	return little.position + sample(bd);
}

function setVector(bd:BitmapData):Number
{
	bd.setVector(rect, vector);
	return sample(bd);
}

function getPixels(bd:BitmapData):Number
{
	var bytes:ByteArray = bd.getPixels(rect);
	return bytes.length + bytes[5] + bytes[bytes.length - 3];
}

function getVector(bd:BitmapData):Number
{
	var v:Vector.<uint> = bd.getVector(rect);
	return v.length + v[1] + v[v.length - 1];
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

bench("setPixels-opaque", 100, setBig, opaque);
bench("setPixels-little-opaque", 100, setLittle, opaque);
bench("setPixels-transparent", 100, setBig, transparent);
bench("setVector-opaque", 100, setVector, opaque);
bench("setVector-transparent", 100, setVector, transparent);
bench("getPixels-transparent", 100, getPixels, transparent);
bench("getVector-transparent", 100, getVector, transparent);
trace("checksum", checksum);
