// Math.random called in tight loops: summed, scaled to an index, and drawn
// for a coin flip, ten million times each. Each section traces whether its
// values were all in range, the same in every player whatever its seed.

const N:int = 10000000;

function sums():Boolean
{
	var sum:Number = 0;
	for (var i:int = 0; i < N; i++)
	{
		sum += Math.random();
	}

	return sum > 0 && sum < N;
}

function indices():Boolean
{
	var bad:int = 0;
	for (var i:int = 0; i < N; i++)
	{
		var k:int = int(Math.random() * 100);
		if (k < 0 || k >= 100)
		{
			bad++;
		}
	}

	return bad == 0;
}

function flips():Boolean
{
	var heads:int = 0;
	for (var i:int = 0; i < N; i++)
	{
		if (Math.random() < 0.5)
		{
			heads++;
		}
	}

	return heads > 0 && heads < N;
}

function bench(name:String, f:Function):void
{
	f();
	var started:Number = new Date().time;
	var ok:Boolean = f();
	trace("time:", name, new Date().time - started);
	trace(name, ok);
}

bench("random-sum", sums);
bench("random-index", indices);
bench("random-flip", flips);
