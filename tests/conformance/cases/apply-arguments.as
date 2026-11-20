// apply takes an Array, or nothing: a Vector is no Array.
function two(x:*, y:*):String
{
	return x + "," + y;
}
try
{
	trace(two.apply(null, new <int>[1, 2]));
}
catch (e:Error)
{
	trace(e.errorID);
}
trace(two.apply(null, [3, 4]));
