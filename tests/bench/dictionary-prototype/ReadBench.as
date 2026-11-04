import flash.utils.Dictionary;

var checksum:Number = 0;
function countKeys(d:*):int {
  var n:int = 0;
  for (var key:* in d) { n++; }
  return n;
}
function countValues(d:*):int {
  var n:int = 0;
  for each (var value:* in d) { n++; }
  return n;
}
function sumValues(d:*):Number {
  var n:Number = 0;
  for each (var value:Number in d) { n += value; }
  return n;
}
function measure(name:String, rounds:int, action:Function, d:*):void {
  trace("check:", name, action(d));
  for (var warm:int = 0; warm < rounds / 10; warm++) { checksum += action(d); }
  var start:Number = new Date().time;
  for (var i:int = 0; i < rounds; i++) { checksum += action(d); }
  trace("time:", name, new Date().time - start);
}
function suite(size:int, weak:Boolean):void {
  var keys:Array = [];
  var dictionary:Dictionary = new Dictionary(weak);
  for (var i:int = 0; i < size; i++) { keys.push({id: i}); dictionary[keys[i]] = i; }
  var rounds:int = size == 1000 ? 2000 : 100000;
  var label:String = (weak ? "weak" : "strong") + size;
  measure(label + "-keys", rounds, countKeys, dictionary);
  measure(label + "-values", rounds, countValues, dictionary);
  measure(label + "-sum", rounds, sumValues, dictionary);
  trace("held", label, keys.length, keys[0].id);
}
suite(16, false);
suite(16, true);
suite(32, false);
suite(32, true);
suite(1000, false);
suite(1000, true);
trace("checksum", checksum);
