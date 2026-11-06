import flash.utils.Dictionary;
function makeDictionary(weak) { return new Dictionary(weak); }
function put(dictionary, key, value) { dictionary[key] = value; }
function read(dictionary, key) { return dictionary[key]; }
function remove(dictionary, key) { return delete dictionary[key]; }
function member(dictionary, key) { return key in dictionary; }
function own(dictionary, key) { return dictionary.hasOwnProperty(key); }
function enumerable(dictionary, key) { return dictionary.propertyIsEnumerable(key); }
function hide(dictionary, key, flag) { dictionary.setPropertyIsEnumerable(key, flag); }
function walk(dictionary, action) {
  for (var key in dictionary) {
    if (action(key) === false) { break; }
  }
}
function walkValues(dictionary, action) {
  for each (var value in dictionary) {
    if (action(value) === false) { break; }
  }
}
function emit(line) { trace(line); }
