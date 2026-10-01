// What is enumerable, as avmplus has it: a Vector's elements are not, to
// propertyIsEnumerable, in or out of range, though hasOwnProperty has them
// in range; a name set not enumerable stays so when set again, but is
// enumerable anew once deleted and set; arguments has a callee, the
// function itself, not enumerated.
var vec:Vector.<int> = new <int>[1, 2];
trace([vec.propertyIsEnumerable("0"), vec.propertyIsEnumerable("1"), vec.propertyIsEnumerable("2"), vec.propertyIsEnumerable("length")].join(","));
trace([vec.hasOwnProperty("0"), vec.hasOwnProperty("1"), vec.hasOwnProperty("2"), vec.hasOwnProperty("length")].join(","));
var obj:Object = {};
obj.prop = 1;
obj.setPropertyIsEnumerable("prop", false);
obj.prop = 3;
trace("set again", obj.propertyIsEnumerable("prop"));
delete obj.prop;
obj.prop = 2;
trace("deleted and set", obj.propertyIsEnumerable("prop"));
var keys:Array = [];
for (var k:String in obj) { keys.push(k); }
trace("keys", keys);
function argprops():* { return arguments.callee; }
var fvar:Function = argprops;
trace("callee", argprops() === argprops, fvar() === argprops, typeof argprops());
function enumArgs():String {
  var s:String = "";
  for (var k:* in arguments) { s += k + ";"; }
  return s + "|" + arguments.hasOwnProperty("callee") + "|" + arguments.propertyIsEnumerable("callee") + "|" + arguments.length + "|" + (arguments.callee === enumArgs);
}
trace("arguments", enumArgs(1, 2));
var anon:Function = function():* { return arguments.callee; };
trace("anon", anon() === anon, anon() === anon());
