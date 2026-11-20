// indexOf and lastIndexOf read a hole as getUintProperty does: undefined,
// or Array.prototype's element there, which a search finds.
var a:Array = new Array(5);
a[1] = 1;
trace(a.indexOf(undefined), a.lastIndexOf(undefined), a.indexOf(undefined, 2), a.lastIndexOf(undefined, -3));
trace(a.indexOf(1), a.lastIndexOf(1), a.indexOf("p"), a.lastIndexOf("p"));
Array.prototype[3] = "p";
trace(a.indexOf("p"), a.lastIndexOf("p"), a.indexOf(undefined), a.lastIndexOf(undefined));
var dense:Array = [1, 2, 3, 2];
trace(dense.indexOf("p"), dense.indexOf(2), dense.lastIndexOf(2), dense.indexOf(undefined));
delete Array.prototype[3];
trace(a.indexOf("p"), a.lastIndexOf(undefined));
