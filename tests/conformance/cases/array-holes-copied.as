// What reads an Array's elements into another, slice and apply among
// them, reads a hole as getUintProperty does: the prototype's element, or
// undefined, which the copy then holds as its own.
var a:Array = new Array(8);
a[2] = 2;
a[4] = 4;
a[6] = 6;
Array.prototype[0] = "p0";
Array.prototype[5] = "p5";
var s:Array = a.slice(-3, -1);
trace(s.length, s[0], s[1], s.hasOwnProperty(0), s.hasOwnProperty(1));
var t:Array = a.slice(0, 3);
trace(t.length, t[0], t[1], t[2], t.hasOwnProperty(0), t.hasOwnProperty(1));
function three(x:*, y:*, z:*):void
{
	trace(x, y, z);
}
var b:Array = [];
b[2] = "two";
three.apply(null, b);
delete Array.prototype[0];
delete Array.prototype[5];
trace(t[0], s[1], a.slice(0, 2)[0], a.slice(0, 2).hasOwnProperty(0));
