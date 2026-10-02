// PCRE syntax JavaScript writes otherwise: named groups and their
// references, inline flags to the end of their group, extended mode
// however it is set, and comment groups; a pattern that does
// not compile matches nothing and throws nothing, a string pattern too;
// and a replacement's $0d, which avmplus reads as group d and the digit d.
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); }
}

probe("named group", function():* { return /(?P<y>\d{4})-(?P=y)/.exec("x 2026-2026 y"); });
probe("named group, a class", function():* { return /[(?P<]+/.exec("a(?P<b"); });
probe("inline flag", function():* { return [/(?i)abc/.test("ABC"), /a(?i)b/.test("aB"), /a(?i)b/.test("AB"), /(?:(?i)a)b/.test("Ab"), /(?:(?i)a)b/.test("AB")].join(","); });
probe("inline flag off", function():* { return [/(?i)a(?-i)b/.test("Ab"), /(?i)a(?-i)b/.test("AB")].join(","); });
probe("no compile", function():* { var r:RegExp = new RegExp("(a"); return r.test("(a") + " " + r.exec("a") + " " + "x(a".search("(a") + " " + "x(a".match("(a"); });
probe("nothing to repeat", function():* { return new RegExp("?").test("?"); });
probe("replace $0d", function():* { return ["one two".replace(/(one) (two)/, "$02-$01"), "ab".replace(/(a)(b)/, "$00|$09|$$01|$1"), "ab".replace(/(a)/, "$01$1")].join(" "); });
probe("extended option", function():* { return [new RegExp("a b # c", "x").test("ab"), new RegExp("a[ ]b", "x").test("a b"), new RegExp("a\\ b", "x").test("a b")].join(","); });
probe("extended inline", function():* { return [new RegExp("(?x)a b").test("ab"), new RegExp("(?x)a b").test("a b"), new RegExp("a(?x) b c").test("abc")].join(","); });
probe("extended scoped", function():* { return [new RegExp("(?x: a b )c d").test("abc d"), new RegExp("(?x: a b )c d").test("abcd")].join(","); });
probe("extended off", function():* { return [new RegExp("a (?-x)b c", "x").test("ab c"), new RegExp("a (?-x)b c", "x").test("abc"), new RegExp("(a (?-x)b )c", "x").test("ab c")].join(","); });
probe("extended comment", function():* { return new RegExp("(?x)a # the a\nb").test("ab"); });
probe("comment group", function():* { return [/a(?#a comment)b/.test("ab"), new RegExp("a(?#)b").test("ab")].join(","); });
// Multiline ^ and $ at PCRE's newlines: ^ never at the very end nor within \r\n.
var lineSubjects:Array = ["a\nb\n", "a\rb\r", "a\r\nb", "a" + String.fromCharCode(0x2028) + "b", "\n", "", "a\n\n", " foo\n  bar\n"];
var anchored:Array = [];
for each (var ls:String in lineSubjects) {
  anchored.push(escape(ls.replace(/^/gm, "#")) + " " + escape(ls.replace(/$/gm, "#")) + " " + escape(ls.replace(/^ */gm, "*")));
}
trace(anchored.join(" | "));
// A global exec from a negative lastIndex fails, and starts over.
var fromBefore:Array = [];
for each (var li:Number in [-1, 4294967295, 2147483648, -4294967296, 3]) {
  var gre:RegExp = /abc/gi;
  gre.lastIndex = li;
  fromBefore.push(li + ":" + gre.exec("AbcaBcabC") + ":" + gre.lastIndex + ":" + gre.test("Abc"));
}
var plain:RegExp = /abc/i;
plain.lastIndex = -1;
trace(fromBefore.join(" "), plain.exec("Abc"));
