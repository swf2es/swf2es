// Number and Boolean in AVM1, by version (docs/avm1.md, "Number, Boolean and Math"):
// toString's radixes, Flash's digits of a number past an int, the constants,
// the constructors called and with new, and the methods on other objects.
var n = 255;
trace("toString " + n.toString() + " " + n.toString(16) + " " + n.toString(2) + " " + n.toString(36) + " " + n.toString(37) + " " + n.toString(1) + " " + n.toString(0) + " " + n.toString("16") + " " + n.toString(16.9) + " " + n.toString(undefined) + " " + n.toString(null));
trace("neg " + (-255).toString(16) + " frac " + (3.75).toString(2) + " " + (-3.75).toString(16) + " big " + (1e20).toString(16) + " " + (4294967296).toString(16) + " " + (2147483648).toString(16) + " " + (-2147483649).toString(16));
trace("nan " + (0/0).toString(16) + " inf " + (1/0).toString(16) + " " + (-1/0).toString(2) + " zero " + (0).toString(16) + " " + (-0).toString(2));
trace("nan10 " + (0/0).toString(10) + " " + (0/0).toString() + " " + (1/0).toString(10));
trace("NaN 3 " + (0/0).toString(3));
trace("MAX " + Number.MAX_VALUE + " MIN " + Number.MIN_VALUE + " NaN " + Number.NaN + " -inf " + Number.NEGATIVE_INFINITY + " inf " + Number.POSITIVE_INFINITY);
Number.MAX_VALUE = 1; trace("readonly " + Number.MAX_VALUE);
trace("delete " + (delete Number.NaN) + " " + Number.NaN);
trace("Number() " + Number() + " " + Number("12") + " " + Number("0x10") + " " + Number(true) + " " + Number(null) + " " + Number(undefined) + " " + Number("abc") + " " + typeof Number("5"));
var no = new Number(5);
trace("obj " + typeof no + " " + no + " " + (no + 1) + " " + no.valueOf() + " " + (no == 5) + " " + (no === 5));
var nn = new Number();
trace("new Number() " + nn);
var ns = new Number("7");
trace("new Number('7') " + ns + " " + typeof ns.valueOf());
var o = {};
o.toStr = Number.prototype.toString; o.valueOf2 = Number.prototype.valueOf;
trace("generic " + o.toStr() + " " + o.valueOf2() + " " + o.toStr(16));
trace("prim call " + ((5).toString === Number.prototype.toString));
trace("Boolean() " + Boolean() + " " + Boolean(1) + " " + Boolean("") + " " + Boolean("0") + " " + Boolean("a") + " " + Boolean(null) + " " + typeof Boolean(1));
var bo = new Boolean(true);
trace("bool obj " + typeof bo + " " + bo + " " + bo.valueOf() + " " + bo.toString() + " " + (bo == true) + " " + (new Boolean(false) ? "truthy" : "falsy"));
trace("new Boolean() " + new Boolean() + " " + new Boolean("0") + " " + new Boolean("x"));
o.btoStr = Boolean.prototype.toString; o.bval = Boolean.prototype.valueOf;
trace("bool generic " + o.btoStr() + " " + o.bval());
trace("true.toString " + true.toString() + " " + false.valueOf());
trace("num len " + (5).length + " bool " + true.length);
