import flash.utils.Dictionary;

const BATCH:int = 4096;

function getHit(d:*, keys:Array, mask:int):Number
{
	var sum:Number = 0;
	for (var i:int = 0; i < BATCH; i++)
	{
		sum += int(d[keys[i & mask]]);
	}

	return sum;
}

function getMiss(d:*, keys:Array, mask:int):Number
{
	var sum:Number = 0;
	for (var i:int = 0; i < BATCH; i++)
	{
		sum += d[keys[i & mask]] === undefined ? 1 : 0;
	}

	return sum;
}

function setHit(d:*, keys:Array, mask:int):Number
{
	for (var i:int = 0; i < BATCH; i++)
	{
		d[keys[i & mask]] = i & mask;
	}

	return BATCH;
}

function hasHit(d:*, keys:Array, mask:int):Number
{
	var sum:Number = 0;
	for (var i:int = 0; i < BATCH; i++)
	{
		sum += keys[i & mask] in d ? 1 : 0;
	}

	return sum;
}

function remove(d:*, keys:Array, mask:int):Number
{
	var sum:Number = 0;
	for (var i:int = 0; i < BATCH; i++)
	{
		var k:* = keys[i & mask];
		sum += delete d[k] ? 1 : 0;
		d[k] = i & mask;
	}

	return sum;
}

var checksum:Number = 0;

function bench(name:String, f:Function, d:*, keys:Array):void
{
	var mask:int = keys.length - 1;
	trace(name, f(d, keys, mask));
	for (var warm:int = 0; warm < 16; warm++)
	{
		checksum += f(d, keys, mask);
	}

	var start:Number = new Date().time;
	for (var round:int = 0; round < 128; round++)
	{
		checksum += f(d, keys, mask);
	}

	trace("time:", name, new Date().time - start);
}

function suite(size:int, weak:Boolean):void
{
	var d:Dictionary = new Dictionary(weak);
	var keys:Array = [];
	var absent:Array = [];
	for (var i:int = 0; i < size; i++)
	{
		keys.push({});
		absent.push({});
		d[keys[i]] = i;
	}

	var name:String = (weak ? "weak" : "strong") + size;
	bench(name + "-get", getHit, d, keys);
	bench(name + "-miss", getMiss, d, absent);
	bench(name + "-set", setHit, d, keys);
	trace(name + "-after-set", getHit(d, keys, size - 1));
	bench(name + "-has", hasHit, d, keys);
	bench(name + "-has-miss", hasHit, d, absent);
	bench(name + "-delete-set", remove, d, keys);
	trace(name + "-after-delete-set", getHit(d, keys, size - 1));
}

// Train membership on both storage kinds before the first short weak-key
// measurement, so receiver-shape deoptimization is outside its timed loop.
var warmStrong:Dictionary = new Dictionary();
var warmWeak:Dictionary = new Dictionary(true);
var warmKeys:Array = [];
for (var w:int = 0; w < 16; w++)
{
	warmKeys.push({});
	warmStrong[warmKeys[w]] = w;
	warmWeak[warmKeys[w]] = w;
}

for (var r:int = 0; r < 128; r++)
{
	hasHit(warmStrong, warmKeys, 15);
	hasHit(warmWeak, warmKeys, 15);
}

suite(16, false);
suite(1024, false);
suite(16, true);
suite(1024, true);
suite(2048, true);

var mixedKeys:Array = [ {}, [], function():void
	{
	}, "s"];
var receivers:Array = [new Dictionary(), new Dictionary(true), {}, []];
for each (var receiver:* in receivers)
{
	for (var j:int = 0; j < mixedKeys.length; j++)
	{
		receiver[mixedKeys[j]] = j;
	}
}

function mixed(d:*, keys:Array, mask:int):Number
{
	var sum:Number = 0;
	for (var i:int = 0; i < BATCH; i++)
	{
		var receiver:* = receivers[i & 3];
		var key:* = keys[(i >> 2) & mask];
		receiver[key] = i & 7;
		sum += int(receiver[key]);
	}

	return sum;
}

bench("mixed-receivers-keys", mixed, null, mixedKeys);
var strings:Array = [];
var named:Dictionary = new Dictionary();
for (var s:int = 0; s < 16; s++)
{
	strings.push("k" + s);
	named[strings[s]] = s;
}

bench("string-get", getHit, named, strings);
bench("string-set", setHit, named, strings);
trace("string-after-set", getHit(named, strings, 15));
trace("checked", checksum);
