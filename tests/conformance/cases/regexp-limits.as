// A pattern avmplus' PCRE cannot compile matches nothing: one that nests
// groups past its pre-compile workspace, some 400 captures or 670 other
// groups deep, fewer with an item before each.
function nest(n:int, open:String, inner:String):String {
  var p:String = "";
  for (var i:int = 0; i < n; i++) {
    p += open;
  }

  p += inner;
  for (i = 0; i < n; i++) {
    p += ")";
  }

  return p;
}

for each (var n:int in [406, 407, 677, 678]) {
  trace(n, "a".search(new RegExp(nest(n, "(", "a"))), "a".search(new RegExp(nest(n, "(?:", "a"))),
    "a".search(new RegExp(nest(n, "(?=", "a"))));
}

var subject:String = "";
for (var k:int = 0; k < 300; k++) {
  subject += "a";
}

trace(subject.search(new RegExp(nest(290, "a(", ""))), subject.search(new RegExp(nest(291, "a(", ""))));
var deep:RegExp = new RegExp(nest(500, "(", "hello"), "g");
trace(deep.source.length, deep.exec("hello"), deep.test("hello"), deep.lastIndex);
trace("hello".match(deep), "hello".replace(deep, "goodbye"), "hello".split(deep));
// As many groups side by side compile.
var flat:String = "";
for (var i:int = 0; i < 1000; i++) {
  flat += "(?:a)";
}

trace("a".search(new RegExp(flat + "|a")));

// A lookbehind must match strings of one length: each of its alternatives
// fixed, each group within of one length, no quantifier but {n}, no back
// reference. PCRE does not compile one that may not.
function lookbehind(p:String, s:String):void {
  trace(p, s, s.search(new RegExp(p)));
}

lookbehind("(?<=a{3,})bla", "aaabla");
lookbehind("(?<=a?)bla", "bla");
lookbehind("(?<=a{2})bla", "aabla");
lookbehind("(?<=a{2,2})bla", "aabla");
lookbehind("(?<=a{1,2})bla", "aabla");
lookbehind("(?<=a{3}|b{2})bla", "bbbla");
lookbehind("(?<=(a{3}|b{2}))bla", "bbbla");
lookbehind("(?<=(?:a{3}|b{2}))bla", "bbbla");
lookbehind("(?<=(a|b)c)bla", "acbla");
lookbehind("(?<=(ab){2})x", "ababx");
lookbehind("(?<=[abc]\\d.)x", "a1zx");
lookbehind("(?<=\\bab)x", "abx");
lookbehind("(?<=^ab)x", "abx");
lookbehind("(?<=ab$)x", "abx");
lookbehind("(?<=(a)\\1)x", "aax");
lookbehind("(?<=a(?=b)b)x", "abx");
lookbehind("(?<=a(?!c)b)x", "abx");
lookbehind("(?<=a(?<=a)b)x", "abx");
lookbehind("(?<=a(?<=a+)b)x", "abx");
lookbehind("(?<!a?)x", "bx");
lookbehind("(?<!a|bc)x", "bx");
lookbehind("(?<!(a|bc))x", "bx");
lookbehind("(?<=\\x41)x", "Ax");
lookbehind("(?<=a{0})x", "x");
lookbehind("(?<=a{2}?)x", "aax");
lookbehind("(?<=a{,2})x", "a{,2}x");
lookbehind("(?<=a{x)x", "a{xx");
lookbehind("(?<=(?i)ab)x", "ABx");
lookbehind("(?<=(?i:ab)|c)x", "ABx");
lookbehind("(?<=a|(b|c))x", "cx");
lookbehind("(?<=a|(b|cd))x", "cdx");
lookbehind("(?<=.)x", "ax");
lookbehind("(?<=[^]]a)x", "zax");
lookbehind("(?<=(?#c)ab)x", "abx");
lookbehind("(?<=a\\Z)x", "ax");
lookbehind("(?<=\\na)x", "\nax");
lookbehind("(?<=(?P<n>a)b)x", "abx");
lookbehind("(?<=(?P=n))x", "ax");
