// indexOf and lastIndexOf read a hole through the Array's whole prototype
// chain, as getUintProperty does: Object.prototype's element, and that of a
// subclass's prototype, which a search finds (array-index-of-holes).
var a:Array = new Array(5);
a[1] = 1;
Object.prototype[3] = "p";
trace(a.indexOf("p"), a.lastIndexOf("p"), a.indexOf("p", 4), a.lastIndexOf("p", 2));
var dense:Array = ["x", "p"];
trace(dense.indexOf("p"), dense.lastIndexOf("p"));
delete Object.prototype[3];
trace(a.indexOf("p"), a.lastIndexOf("p"));

dynamic class Sub extends Array {}

Sub.prototype[2] = "q";
var s:Sub = new Sub();
s[0] = "a";
s[1] = "b";
s[3] = "d";
trace(s.length, s.indexOf("q"), s.lastIndexOf("q"), s.indexOf("d"));
var plain:Array = new Array(4);
trace(plain.indexOf("q"), plain.lastIndexOf("q"));
delete Sub.prototype[2];
trace(s.indexOf("q"), s.lastIndexOf("q"));

// A float searched for reads holes through the chain too.
var f:Array = new Array(3);
f[0] = 0.5;
Object.prototype[2] = 1.5;
trace(f.indexOf(1.5), f.lastIndexOf(1.5));
delete Object.prototype[2];
