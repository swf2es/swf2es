import flash.utils.Dictionary;

var checksum:Number = 0;
function drain(dictionary:*, keys:Array):int {
  for (var i:int = 0; i < keys.length; i++) { dictionary[keys[i]] = i; }
  var n:int = 0;
  for (var key:* in dictionary) { delete dictionary[key]; n++; }
  return n;
}
function suite(weak:Boolean):void {
  var keys:Array = [];
  for (var i:int = 0; i < 1000; i++) { keys.push({id: i}); }
  var dictionary:Dictionary = new Dictionary(weak);
  var label:String = (weak ? "weak" : "strong") + "1000-drain";
  trace("check:", label, drain(dictionary, keys));
  for (var warm:int = 0; warm < 20; warm++) { checksum += drain(dictionary, keys); }
  var start:Number = new Date().time;
  for (var round:int = 0; round < 200; round++) { checksum += drain(dictionary, keys); }
  trace("time:", label, new Date().time - start);
  var remaining:int = 0;
  for (var key:* in dictionary) { remaining++; }
  trace("empty:", label, remaining);
  trace("held:", label, keys.length, keys[0].id);
}
suite(false);
suite(true);
trace("checksum", checksum);
