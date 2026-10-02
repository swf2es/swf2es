// Strings: the methods, comparison, and conversion.
var s:String = "Hello, World";
trace(s.length, s.charAt(4), s.charCodeAt(0), s.indexOf("o"), s.lastIndexOf("o"), s.indexOf("z"));
trace(s.substring(7), s.substring(5, 0), s.substr(-5, 3), s.slice(-5, -1), s.slice(3));
trace(s.toUpperCase(), s.toLowerCase(), s.split(", "), s.split(""), s.split("o", 2));
trace(s.replace("o", "0"), s.replace(/o/g, "0"), s.replace(/(\w+), (\w+)/, "$2 $1"), s.search(/W/));
trace(s.match(/l+/g), s.match(/(W)(o)/), "abc".match(/z/));
trace(String.fromCharCode(72, 105), "a" < "b", "B" < "a", "abc".localeCompare("abd"), "x".concat(1, 2));
trace("  trim  ".length, "a,b,,c".split(","), "tab\there", "quote\"s", "unié");
var re:RegExp = /(\d+)-(\d+)/g;
var str:String = "1-2 33-44";
var m:Object;
while ((m = re.exec(str)) != null) trace(m[0], m[1], m[2], m.index, re.lastIndex);
trace(re.source, re.global, re.ignoreCase, String(re), /a/i.test("A"));
trace("abc".replace(/b/, function(match:String, pos:int, all:String):String { return "[" + match + pos + "]"; }));
// A global match: each match from where the last ended, until one fails or
// is empty; lastIndex is left where the last try ended, or one on.
function matches(s:String, re:RegExp):String {
  re.lastIndex = 3;
  var m:Array = s.match(re);
  return (m === null ? "null" : m.length + "[" + m.join("|") + "]") + " " + re.lastIndex;
}
trace(matches("ABC abc", /z/ig), matches("ABC abc", /z/i), matches("aXbXc", /X/g));
trace(matches("abc", /x*/g), matches("aab", /a*/g), matches("aaxb", /a|x*/g), matches("éaéa", /a/g));
// lastIndexOf from before the start finds nothing, even the empty string.
var gero:String = "Gero";
var gi:int = -1;
trace(gero.lastIndexOf("G", -1), gero.lastIndexOf("G", gi), gero.lastIndexOf("G", -0.5), gero.lastIndexOf("", -1), gero.lastIndexOf("o", NaN), String.prototype.lastIndexOf.call(gero, "G", -2));
