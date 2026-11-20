// String.replace with a global RegExp replaces every match from the start
// and leaves the RegExp's lastIndex as it was; with one not global, too.
var g:RegExp = /a/g;
g.lastIndex = 1;
trace("aaaa".replace(g, "x"), g.lastIndex);
g.lastIndex = 3;
trace("bab".replace(g, function(m:String, i:int, s:String):String { return "[" + i + "]"; }), g.lastIndex);
var n:RegExp = /a/;
n.lastIndex = 2;
trace("aaaa".replace(n, "x"), n.lastIndex);
g.lastIndex = 0;
trace("cccc".replace(g, "x"), g.lastIndex);
// What a replacement function does to lastIndex stays: avmplus never sets it back.
var c:RegExp = /a/g;
c.lastIndex = 2;
"aaa".replace(c, function(...r):String { c.lastIndex = 7; return "x"; });
trace(c.lastIndex);
var h:RegExp = /a/g;
h.lastIndex = 1;
trace("aba".replace(h, function(...r):String { return String(h.test("zzza")) + h.lastIndex; }), h.lastIndex);
var m:RegExp = /a/;
m.lastIndex = 2;
"aaa".replace(m, function(...r):String { m.lastIndex = 9; return "x"; });
trace(m.lastIndex);
