// A weak Dictionary's walks read each key's slot once and keep what they
// read while the script runs: nested walks, for each after for-in, keys
// deleted and set again during and between walks, and string and number
// keys among the object keys must go as a strong Dictionary's do.
import flash.utils.Dictionary;

function label(key:*):String
{
	return key is String || key is Number ? typeof key + " " + key : "object " + key.id;
}

function names(dictionary:Dictionary):String
{
	var result:Array = [];
	for (var key:* in dictionary)
	{
		result.push(label(key) + "=" + dictionary[key]);
	}

	return result.sort().join(", ");
}

function values(dictionary:Dictionary):String
{
	var result:Array = [];
	for each (var value:* in dictionary)
	{
		result.push(String(value));
	}

	return result.sort().join(", ");
}

function exercise(weak:Boolean):void
{
	trace(weak ? "weak" : "strong");
	var dictionary:Dictionary = new Dictionary(weak);
	var keys:Array = [];
	for (var i:int = 0; i < 12; i++)
	{
		keys.push({id: i});
		dictionary[keys[i]] = "v" + i;
	}

	dictionary["name"] = "named";
	dictionary[7] = "seven";
	dictionary[1.5] = "half";
	trace("names", names(dictionary));
	trace("values", values(dictionary));
	trace("again", names(dictionary) == names(dictionary), values(dictionary) == values(dictionary));

	// Nested walks over the one Dictionary: each inner one goes through them all.
	var pairs:int = 0;
	var inner:int = 0;
	for (var outer:* in dictionary)
	{
		for each (var value:* in dictionary)
		{
			pairs++;
			for (var innermost:* in dictionary)
			{
				inner++;
			}
		}
	}

	trace("nested", pairs, inner);

	// Each key deleted as the walk comes to it: the walk still goes through the rest.
	var visited:Array = [];
	for (var key:* in dictionary)
	{
		visited.push(label(key) + "=" + dictionary[key]);
		delete dictionary[key];
		if (dictionary[key] !== undefined || key in dictionary)
		{
			trace("still there", label(key));
		}
	}

	trace("deleted at", visited.sort().join(", "));
	trace("empty", names(dictionary), values(dictionary));

	// Set again after a walk has seen them gone, with other values.
	for (i = 0; i < 12; i += 2)
	{
		dictionary[keys[i]] = "w" + i;
	}

	dictionary["name"] = "renamed";
	trace("set again", names(dictionary));
	trace("values", values(dictionary));

	// Values replaced during a for each, read by the walks inside and after it.
	var seen:int = 0;
	for each (value in dictionary)
	{
		seen++;
		for (key in dictionary)
		{
			if (dictionary[key] == value)
			{
				dictionary[key] = value + "!";
			}
		}
	}

	trace("replaced", seen, values(dictionary));

	// All the others deleted at a walk's first step: it goes through no more.
	var steps:int = 0;
	for (key in dictionary)
	{
		steps++;
		for each (var held:Object in keys)
		{
			if (held !== key)
			{
				delete dictionary[held];
			}
		}

		delete dictionary["name"];
		trace("inside", names(dictionary) == (key is String ? "" : label(key) + "=" + dictionary[key]));
	}

	trace("one left", steps);

	// Keys added during a walk are there for the next.
	for (i = 0; i < 12; i++)
	{
		dictionary[keys[i]] = i;
	}

	var before:int = 0;
	for (key in dictionary)
	{
		before++;
	}

	var extra:Array = [];
	var first:Boolean = true;
	for (key in dictionary)
	{
		if (first)
		{
			first = false;
			for (i = 0; i < 4; i++)
			{
				extra.push({id: 100 + i});
				dictionary[extra[i]] = 100 + i;
			}
		}
	}

	var after:int = 0;
	for (key in dictionary)
	{
		after++;
	}

	trace("added", before, after, values(dictionary));
}

exercise(false);
exercise(true);
