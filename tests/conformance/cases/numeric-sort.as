package
{
	// Array.NUMERIC sorts of numbers, whose order avmplus' quicksort decides
	// for equal elements too: RETURNINDEXEDARRAY shows it, as do -0 and 0.
	function signed(a:*):String
	{
		var out:Array = [];
		for (var i:int = 0; i < a.length; i++)
		{
			var x:* = a[i];
			out.push(x === 0 && 1 / x < 0 ? "-0" : String(x));
		}

		return out.join(",");
	}

	function show(name:String, a:*, options:uint):void
	{
		var copy:* = a.concat();
		var indices:* = a.sort(Array.NUMERIC | options | Array.RETURNINDEXEDARRAY);
		trace(name, "indices", indices);
		var sorted:* = copy.sort(Array.NUMERIC | options);
		trace(name, "sorted", sorted is Array || sorted is Vector.<Number> || sorted is Vector.<int> || sorted is Vector.<uint> ? signed(sorted) : sorted);
	}

	var seed:uint = 12345;
	function next(range:int):int
	{
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % range;
	}

	var many:Array = [];
	for (var i:int = 0; i < 300; i++)
	{
		many.push(next(20) - 10);
	}

	var specials:Array = [3, NaN, -0, 0, 1, -Infinity, Infinity, NaN, 0, -0, 2.5, -1, Infinity, -Infinity, 1e300, -1e-300, 0];
	var ints:Vector.<int> = new <int>[5, -3, 2147483647, -2147483648, 0, -3, 5, 7, 7, 1];
	var uints:Vector.<uint> = new <uint>[4294967295, 0, 2147483648, 2147483647, 1, 4294967295, 3000000000, 2];
	var numbers:Vector.<Number> = new <Number>[2, NaN, -0, 0, -Infinity, Infinity, 1.5, NaN, 0, -0, 1.5];
	var manyNumbers:Vector.<Number> = new Vector.<Number>();
	for (i = 0; i < 200; i++)
	{
		manyNumbers.push((next(9) - 4) * 0.5);
	}

	for each (var options:uint in [0, Array.DESCENDING])
	{
		var tag:String = options ? "descending" : "ascending";
		show(tag + " small", [3, 1, 2], options);
		show(tag + " pair", [2, 1], options);
		show(tag + " many", many.concat(), options);
		show(tag + " specials", specials.concat(), options);
		show(tag + " ints", ints.concat(), options);
		show(tag + " uints", uints.concat(), options);
		show(tag + " numbers", numbers.concat(), options);
		show(tag + " manyNumbers", manyNumbers.concat(), options);
		// Strings and Booleans among the numbers convert as they are compared.
		show(tag + " mixed", [3, "2", 10, "1e1", true, 0.5, "-4", false], options);
	}

	// UNIQUESORT fails on equal neighbours and leaves the elements as they were.
	var unique:Array = [3, 1, 2];
	trace("unique", unique.sort(Array.NUMERIC | Array.UNIQUESORT), unique);
	var twice:Array = [3, 1, 3, 2];
	trace("unique twice", twice.sort(Array.NUMERIC | Array.UNIQUESORT), twice);
	var zeros:Array = [1, -0, 0];
	trace("unique zeros", zeros.sort(Array.NUMERIC | Array.UNIQUESORT), signed(zeros));
	var nans:Array = [NaN, 1, NaN];
	trace("unique NaNs", nans.sort(Array.NUMERIC | Array.UNIQUESORT), nans);
	var infinities:Array = [Infinity, 1, Infinity];
	trace("unique infinities", signed(infinities.sort(Array.NUMERIC | Array.UNIQUESORT)), infinities);
	var down:Array = [-Infinity, 1, -Infinity];
	trace("unique -infinities", signed(down.sort(Array.NUMERIC | Array.UNIQUESORT | Array.DESCENDING)), down);
	var uniqueIndices:Array = [5, 2, 9];
	trace("unique indices", uniqueIndices.sort(Array.NUMERIC | Array.UNIQUESORT | Array.RETURNINDEXEDARRAY), uniqueIndices);
	var vectorTwice:Vector.<int> = new <int>[4, 4, 1];
	trace("unique vector", vectorTwice.sort(Array.NUMERIC | Array.UNIQUESORT), vectorTwice);

	// Missing and undefined elements are not Numbers to a numeric sort.
	try
	{
		var withUndefined:Array = [3, undefined, 1];
		withUndefined.sort(Array.NUMERIC);
	}
	catch (e:TypeError)
	{
		trace("undefined", e.errorID);
	}

	var holes:Array = [3, 1];
	holes[4] = 2;
	try
	{
		holes.sort(Array.NUMERIC);
	}
	catch (e:TypeError)
	{
		trace("holes", e.errorID, holes);
	}

	var empty:Array = [];
	trace("empty", empty.sort(Array.NUMERIC), empty.sort(Array.NUMERIC | Array.RETURNINDEXEDARRAY));
	var one:Vector.<Number> = new <Number>[-0];
	trace("one", signed(one.sort(Array.NUMERIC)));
}
