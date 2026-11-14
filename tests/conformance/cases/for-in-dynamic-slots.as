// What a for-in goes through as an object's dynamic properties are deleted
// during it, added to an Array during its elements, and added and deleted
// between walks. Names added to an Object during a walk are left out: they
// grow avmplus' hashtable, which moves names, so that avmshell may go
// through one twice.
function count(x:*):int
{
	var n:int = 0;
	for (var k:* in x)
	{
		n++;
	}

	return n;
}

var p:Object = {a: 1, b: 2, c: 3, d: 4};
var visited:int = 0;
var first:Boolean = true;
for (var k2:* in p)
{
	visited++;
	if (first)
	{
		first = false;
		for each (var name:String in ["a", "b", "c", "d"])
		{
			if (name != k2)
			{
				delete p[name];
			}
		}
	}
}

trace("others deleted in the first step", visited, count(p));

var arr:Array = [1, 2, 3];
arr.x = 1;
visited = 0;
for (var k5:* in arr)
{
	visited++;
	if (k5 == 0)
	{
		arr.y = 2;
	}
}

trace("array, name added during the elements", visited, count(arr));

// An object used as a set between walks.
var set :Object = {};
var total:int = 0;
for (var round:int = 0; round < 40; round++)
{
	for (var i:int = 0; i < 100; i++)
	{
		set ["k" + ((round * 37 + i) % 150)] = i;
	}

	for (var j:int = 0; j < 60; j++)
	{
		delete set ["k" + ((round * 11 + j) % 150)];
	}

	total += count(set );
}

trace("churned between walks", total, count(set ));

// Deleted and set again before the next walk: walked once.
var r:Object = {a: 1, b: 2};
for (var round2:int = 0; round2 < 5; round2++)
{
	delete r.a;
	r.a = round2;
}

trace("deleted and set again", count(r), r.a);
