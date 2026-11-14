// Stable walks, value writes and nested walks through Dictionary cache invalidation.
import flash.utils.Dictionary;

function snapshot(dictionary:Dictionary):String
{
	var result:Array = [];
	for (var key:* in dictionary)
	{
		result.push((key is String ? key : key.id) + ":" + dictionary[key]);
	}

	return result.sort().join(",");
}

function exercise(weak:Boolean):void
{
	var dictionary:Dictionary = new Dictionary(weak);
	var keys:Array = [ {id: "a"}, {id: "b"}, {id: "c"}];
	dictionary[keys[0]] = 1;
	dictionary[keys[1]] = 2;
	dictionary[keys[2]] = undefined;
	trace(weak, snapshot(dictionary), snapshot(dictionary));

	var visits:Array = [];
	for (var key:* in dictionary)
	{
		dictionary[key] = key.id;
		visits.push(key.id);
		snapshot(dictionary);
	}

	trace("updated", visits.sort(), snapshot(dictionary));
	dictionary.note = "named";
	trace("mixed", snapshot(dictionary), snapshot(dictionary));
	delete dictionary.note;
	trace("objects", snapshot(dictionary), snapshot(dictionary));

	delete dictionary[keys[1]];
	trace("deleted", snapshot(dictionary));
	dictionary[keys[1]] = 4;
	trace("reinserted", snapshot(dictionary), snapshot(dictionary));
	visits = [];
	for (key in dictionary)
	{
		visits.push(true);
		for each (var held:Object in keys)
		{
			delete dictionary[held];
		}

		snapshot(dictionary);
	}

	trace("emptied", visits.length, snapshot(dictionary), snapshot(dictionary));
}

exercise(false);
exercise(true);
