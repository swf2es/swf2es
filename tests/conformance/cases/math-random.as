package
{
	// Math.random, and Number.random, as avmplus' generator gives them: each
	// value an int from 0 to 2^31 - 1 over 2^31, never one of JavaScript's 52
	// bits. The seed is the clock's, so only what holds of every sequence is
	// traced.
	var draws:int = 100000;
	var offGrid:int = 0;
	var below:int = 0;
	var above:int = 0;
	for (var i:int = 0; i < draws; i++)
	{
		var r:Number = Math.random();
		var k:Number = r * 2147483648;
		if (k != Math.floor(k))
		{
			offGrid++;
		}
		if (r < 0)
		{
			below++;
		}
		if (r >= 1)
		{
			above++;
		}
	}
	trace("grid", offGrid, below, above);

	var heads:int = 0;
	for (i = 0; i < draws; i++)
	{
		if (Math.random() < 0.5)
		{
			heads++;
		}
	}
	trace("heads near half", heads > draws * 0.45 && heads < draws * 0.55);
	trace("type", typeof Math.random(), Math.random.length);
}
