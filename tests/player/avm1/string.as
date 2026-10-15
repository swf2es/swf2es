// String in AVM1, by version (docs/avm1.md, "Array and String"): each
// method's arguments and edges, split's delimiters (a SWF 5 splits only at
// one character), String objects and String's methods on other objects,
// and the case mappings.
var s = "Hello, World";
trace("len " + s.length);
trace("charAt " + s.charAt(1) + "|" + s.charAt(-1) + "|" + s.charAt(100) + "|" + s.charAt() + "|" + s.charAt("2") + "|" + s.charAt(1.9) + "|" + s.charAt(0/0));
trace("charCodeAt " + s.charCodeAt(1) + " " + s.charCodeAt(-1) + " " + s.charCodeAt(100) + " " + s.charCodeAt() + " " + s.charCodeAt(0/0));
trace("concat " + s.concat("!", 1, null, undefined, true) + " " + s.concat());
trace("indexOf " + s.indexOf("o") + " " + s.indexOf("o", 5) + " " + s.indexOf("o", -5) + " " + s.indexOf("z") + " " + s.indexOf("") + " " + s.indexOf("", 100) + " " + s.indexOf() + " " + s.indexOf("o", 100) + " " + s.indexOf("o", undefined) + " " + s.indexOf(undefined));
trace("lastIndexOf " + s.lastIndexOf("o") + " " + s.lastIndexOf("o", 5) + " " + s.lastIndexOf("o", -5) + " " + s.lastIndexOf("o", 4) + " " + s.lastIndexOf("") + " " + s.lastIndexOf() + " " + s.lastIndexOf("o", 100) + " " + s.lastIndexOf("lo", 3) + " " + s.lastIndexOf("o", undefined) + " " + s.lastIndexOf("", 3));
trace("slice " + s.slice(1, 4) + "|" + s.slice(-5) + "|" + s.slice(-5, -2) + "|" + s.slice(4, 1) + "|" + s.slice() + "|" + s.slice(2) + "|" + s.slice(2, undefined) + "|" + s.slice(undefined, 3) + "|" + s.slice(2, null));
trace("substring " + s.substring(1, 4) + "|" + s.substring(4, 1) + "|" + s.substring(-3, 2) + "|" + s.substring(3) + "|" + s.substring() + "|" + s.substring(3, undefined) + "|" + s.substring(3, null) + "|" + s.substring(undefined, 3) + "|" + s.substring(3, 100));
trace("substr " + s.substr(1, 3) + "|" + s.substr(-5, 2) + "|" + s.substr(3) + "|" + s.substr() + "|" + s.substr(2, -1) + "|" + s.substr(2, undefined) + "|" + s.substr(2, null) + "|" + s.substr(undefined, 2) + "|" + s.substr(100) + "|" + s.substr(-100, 3));
trace("upper " + s.toUpperCase() + " lower " + s.toLowerCase());
trace("split " + s.split(", ").length + " " + s.split(", ") + "|" + s.split("") + "|" + s.split() + "|" + s.split().length + "|" + s.split(undefined).length + "|" + s.split("o", 2) + "|" + s.split("o", 0).length + "|" + s.split("o", -1) + "|" + s.split("zz") + "|" + s.split("", 3) + "|" + "".split(",").length + "|" + "".split("").length + "|" + "a,b,".split(",").length + "|" + s.split(null) + "|" + "1n2".split(null).length);
trace("split num " + "1a2a3".split("a", "2") + " " + "a1b1c".split(1));
trace("fromCharCode " + String.fromCharCode(72, 105) + "|" + String.fromCharCode() + "|" + String.fromCharCode(72, 0, 105) + "|" + String.fromCharCode("65") + "|" + String.fromCharCode(65.9) + "|" + String.fromCharCode(65 + 65536) + "|" + String.fromCharCode(-1).length);
trace("valueOf " + s.valueOf() + " toString " + s.toString());
var so = new String("abc");
trace("obj " + typeof so + " " + so.length + " " + so + " " + (so == "abc") + " " + so.charAt(1) + " " + so.valueOf());
trace("String() " + String() + "|" + String(5) + "|" + String(null) + "|" + String(undefined) + "|" + String(true) + "|" + typeof String(5));
var n = 12345;
trace("num methods " + n.toString().length + " " + "x".concat(n));
var o = {toString: function () { return "OBJ"; }};
o.charAt = String.prototype.charAt; o.indexOf = String.prototype.indexOf; o.toUpperCase = String.prototype.toUpperCase; o.split = String.prototype.split; o.substr = String.prototype.substr; o.slice = String.prototype.slice; o.lastIndexOf = String.prototype.lastIndexOf;
trace("generic " + o.charAt(1) + " " + o.indexOf("J") + " " + o.toUpperCase() + " " + o.split("B") + " " + o.substr(1) + " " + o.slice(1) + " " + o.lastIndexOf("O"));
o.valueOf = String.prototype.valueOf; o.toStr = String.prototype.toString;
trace("generic valueOf " + o.valueOf() + " " + o.toStr());
trace("len prop " + "abc".length + " " + so.length);
so.length = 10;
trace("set len " + so.length);
trace("abc"["length"] + " " + "abc".LENGTH);
var t = "a";
t.foo = 1;
trace("prim set " + t.foo);
trace("case " + "AbC".touppercase);
trace("strobj add " + (new String("a") + new String("b")));
trace("strobj eq " + (new String("a") == new String("a")));
trace("toLowerCase ÀÉÎ İ Σ ß ẞ " + "ÀÉÎ İ Σ ß ẞ".toLowerCase() + " " + "àéî ı σ ς ß ẞ ÿ ﬀ".toUpperCase());

// -- split
function sp(s, d) { var a = s.split(d); trace("[" + s + "].split(" + d + ") " + a.length + " <" + a.join("|") + ">"); }
sp("a--b--c", "--");
sp("a-b-c", "-");
sp("a,b,c", ",");
sp("a,b,c", "");
sp("a,b,c");
sp("a b", " ");
sp("abc", "b");
sp("abcbd", "bc");
sp("aXbXc", "X");
sp("a,,b", ",");
sp(",a,", ",");
sp("", "");
sp("", ",");
sp("", "x");
sp("a", "a");
sp("aa", "a");
sp("abab", "ab");
sp("a,b", ", ");
var a = "a,b,c".split(",", 2); trace("limit " + a);
a = "a,b,c".split(",", 1.5); trace("limit 1.5 " + a);
a = "a,b,c".split(",", "x"); trace("limit x " + a.length);
a = "a,b,c".split(",", null); trace("limit null " + a.length);
a = "abc".split("", 2); trace("empty limit " + a);
a = "abc".split(undefined, 2); trace("undef limit " + a);
var t = "x"; trace("typeof split " + typeof t.split);

// -- surrogate pairs: their halves cut and joined again, a lone one traced
var e = "a\ud83d\ude0bb";
trace("pair " + e.length + " " + e.charAt(1) + e.charAt(2) + " " + e.slice(1, 2) + " " + e.substring(0, 2) + " " + e.charCodeAt(2) + " " + e.substr(2).length + " " + e.split("").length + " " + e.split("\ud83d\ude0b"));
trace("halves " + e.slice(1, 2) + e.substr(2, 1) + " " + (e.charAt(1) + e.charAt(2) == "\ud83d\ude0b"));
trace("fromCharCode pair " + String.fromCharCode(0xd83d, 0xde0b) + " half " + String.fromCharCode(0xd83d).length + " " + (String.fromCharCode(0xde0b) == "\ufffd") + " " + String.fromCharCode(0xd83d));
trace("split undefined 0 " + "a,b".split(undefined, 0).length + " " + "a,b".split(undefined, 1));

// substring from the end on, and split's limit with an empty delimiter or string
var se = "abcdef";
trace("substring end " + se.substring(10, 2) + "|" + se.substring(6, 2) + "|" + se.substring(5, 2) + "|" + se.substring(6) + "|" + se.substring(10, -5) + "|" + se.substring(2, 10));
function parts(a) { var r = a.length + ":"; for (var i = 0; i < a.length; i++) { r += "<" + a[i] + ">"; } return r; }
trace("split limits " + parts("a,b".split("", 0)) + " " + parts("a,b".split(",,", 0)) + " " + parts("".split(",", 0)) + " " + parts("".split(",")) + " " + parts("".split("")) + " " + parts("".split("", 0)));
