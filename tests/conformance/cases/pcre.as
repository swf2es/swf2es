// PCRE syntax JavaScript writes otherwise: named groups and their
// references, inline flags to the end of their group; a pattern that does
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
