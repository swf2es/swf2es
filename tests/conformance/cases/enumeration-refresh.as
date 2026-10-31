// Repeated walks keep mixed Dictionary keys through deletions, additions and nested walks.
import flash.utils.Dictionary;

function namesOf(dictionary:Dictionary, keys:Array):String {
  var names:Array = [];
  for (var key:* in dictionary) {
    var index:int = keys.indexOf(key);
    names.push(index < 0 ? String(key) : "object" + index);
  }

  return names.sort().join(",");
}

function exercise(weak:Boolean):void {
  var dictionary:Dictionary = new Dictionary(weak);
  var keys:Array = [];
  for (var i:int = 0; i < 64; i++) {
    keys.push({id: i});
    dictionary[keys[i]] = i;
    dictionary["string" + i] = i;
  }

  trace("initial", weak, namesOf(dictionary, keys));

  for (i = 0; i < 64; i += 2) {
    delete dictionary[keys[i]];
    delete dictionary["string" + i];
  }

  for (i = 64; i < 96; i++) {
    keys.push({id: i});
    dictionary[keys[i]] = i;
    dictionary["string" + i] = i;
  }

  dictionary[keys[1]] = undefined;
  trace("changed", weak, namesOf(dictionary, keys));
  var undefinedValues:int = 0;
  for each (var value:* in dictionary) {
    if (value === undefined) {
      undefinedValues++;
    }
  }

  trace("undefined", weak, undefinedValues);
  var nested:Boolean = false;
  var valid:Boolean = true;
  var seen:Object = {};
  for (var key:* in dictionary) {
    valid = valid && key in dictionary;
    var index:int = keys.indexOf(key);
    seen[index < 0 ? String(key) : "object" + index] = true;
    if (!nested) {
      nested = true;
      for (i = 0; i < keys.length; i += 4) {
        delete dictionary[keys[i]];
        delete dictionary["string" + i];
      }

      namesOf(dictionary, keys);
    }
  }

  var remaining:Array = namesOf(dictionary, keys).split(",");
  for each (var name:String in remaining) {
    valid = valid && seen[name] === true;
  }

  trace("nested", weak, valid, remaining.join(","));
}

exercise(false);
exercise(true);
