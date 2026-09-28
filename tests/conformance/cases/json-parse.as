// JSON.parse on text either parser could take: what each value reads as
// (keys sorted, as avmplus orders an object's keys by its hashtable; a
// string outside ASCII by its code units), and the errors; any depth. The
// reviver's calls are traced through arrays and one-key objects, whose
// order is fixed. Raw lone surrogates are left out: avmplus reads the
// text as UTF-8, where one takes the character after it (the closing
// quote too, failing), and swf2es keeps each as it is.
function canon(v:*):String {
  if (v is String && /[^\x20-\x7e]/.test(v)) return "string:" + codes(v);
  if (v === null || v === undefined || typeof v != "object") return typeof v + ":" + (typeof v == "number" && v == 0 && 1 / v < 0 ? "-0" : String(v));
  var parts:Array = [];
  if (v is Array) {
    for (var i:int = 0; i < v.length; i++) parts.push(canon(v[i]));
    return "[" + parts.join(",") + "](" + v.length + ")";
  }
  for (var k:String in v) parts.push(k + "=" + canon(v[k]));
  parts.sort();
  return "{" + parts.join(",") + "}";
}
function codes(s:String):String {
  var c:Array = [];
  for (var i:int = 0; i < s.length; i++) c.push(s.charCodeAt(i).toString(16));
  return c.join(",");
}
function p(text:String):void {
  try { trace(JSON.stringify(text), canon(JSON.parse(text))); } catch (e:Error) { trace(JSON.stringify(text), "threw", e.errorID); }
}
for each (var t:String in [
  "0", "-0", "01", "-01", "00", "00.5", "1.5e3", "1E-3", "-1e+2", "1e400", "-1e400", "5e-324", "2e-324", "1.7976931348623157e308",
  "123456789012345678901234567890", "0.1", "9007199254740993", "4294967296", "1.", ".5", "-", "+1", "1e", "0x10", "Infinity", "NaN",
  "true", "false", "null", " \t\n\r 1 \t\n\r ", "\u00a01", "\ufeff1", "[]", "{}", "[1,]", "{\"a\":1,}", "[,1]", "{a:1}", "{'a':1}",
  "[1 2]", "\"\"", "\"\\u0041\\u00e9\\u20ac\"", "\"\\ud83d\\ude00\"", "\"\\/\\b\\f\\n\\r\\t\\\\\\\"\"", "\"\\x41\"", "\"\\u12\"",
  "\"\\uzzzz\"", "\"a\u0001b\"", "\"tab\there\"", "\"\u2028\u2029\"", "\"unterminated", "nul", "truex", "[true false]",
  "{\"a\":1,\"a\":2}", "{\"1\":\"one\",\"01\":\"zero one\",\"-1\":\"minus\",\"1.5\":\"frac\",\"4294967295\":\"max\"}",
  "{\"__proto__\":{\"x\":1},\"$traits\":2,\"$d\":3,\"$a\":4,\"$p\":5,\"toString\":6,\"hasOwnProperty\":7,\"constructor\":8}",
  "{\"\":1}", "[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]", "{\"a\":[{\"b\":{\"c\":[null,true,{}]}}]}", "", " ", "[1]x", "1 2"
]) p(t);
trace("lone", codes(JSON.parse("\"\\ud800x\\udc00\"")));
var deep:String = "";
for (var n:int = 0; n < 100000; n++) deep += "[";
deep += "{\"k\":1}";
for (n = 0; n < 100000; n++) deep += "]";
var d:* = JSON.parse(deep);
for (n = 0; n < 100000; n++) d = d[0];
trace("deep", canon(d));
var o:Object = JSON.parse("{\"a\":1}");
o.b = 2;
trace("usable", canon(o), o.hasOwnProperty("a"), o.propertyIsEnumerable("a"), "a" in o, o is Object, (JSON.parse("[1,2]") as Array).concat([3]));
var calls:Array = [];
var revived:* = JSON.parse("[1,[2,{\"x\":3}],\"s\"]", function(k:String, v:*):* {
  calls.push((this is Array ? "array" : typeof this) + "/" + k + "/" + canon(v));
  return typeof v == "number" ? v * 10 : v;
});
trace("reviver", canon(revived), calls.join(" "));
var mutated:* = JSON.parse("[1,2,3]", function(k:String, v:*):* {
  if (k == "0") this[2] = 30;
  return k == "1" ? undefined : v;
});
trace("reviver mutates", canon(mutated));
trace("reviver root", canon(JSON.parse("{\"a\":1}", function(k:String, v:*):* { return k == "" ? "root" : v; })));
try { JSON.parse("[1]", function(k:String, v:*):* { throw new RangeError("from reviver"); }); } catch (e:RangeError) { trace("reviver throws", e.message); }
try { JSON.parse(null); } catch (e:Error) { trace("null", e.errorID); }
trace("non-string", canon(JSON.parse(12)), canon(JSON.parse(true)));
trace("toString", canon(JSON.parse({toString: function():String { return "[7]"; }})));
