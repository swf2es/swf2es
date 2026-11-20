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
