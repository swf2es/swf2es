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
