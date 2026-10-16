// Math in AVM1, by version (docs/avm1.md, "Number, Boolean and Math"): each
// method's results and edges, a SWF up to 6's NaN for too few arguments,
// the two arguments converted whatever a method uses, and RandomNumber.
trace("consts " + Math.E + " " + Math.LN10 + " " + Math.LN2 + " " + Math.LOG10E + " " + Math.LOG2E + " " + Math.PI + " " + Math.SQRT1_2 + " " + Math.SQRT2);
trace("abs " + Math.abs(-3.5) + " " + Math.abs() + " " + Math.abs("x") + " " + Math.abs(null) + " " + Math.abs(-0));
trace("min " + Math.min(1, 2) + " " + Math.min() + " " + Math.min(5) + " " + Math.min(1, 0/0) + " " + Math.min(0/0, 1) + " " + Math.min(3, 1, 0) + " " + Math.min(-0, 0) + " " + Math.min("2", "10"));
trace("max " + Math.max(1, 2) + " " + Math.max() + " " + Math.max(5) + " " + Math.max(1, 0/0) + " " + Math.max(3, 1, 9) + " " + Math.max(-0, 0));
trace("trig " + Math.sin(1) + " " + Math.cos(1) + " " + Math.tan(1) + " " + Math.asin(0.5) + " " + Math.acos(0.5) + " " + Math.atan(1) + " " + Math.atan2(1, 2) + " " + Math.atan2(1) + " " + Math.atan2());
trace("exp " + Math.exp(1) + " " + Math.log(10) + " " + Math.sqrt(2) + " " + Math.sqrt(-1) + " " + Math.log(0) + " " + Math.log(-1));
trace("round " + Math.round(2.5) + " " + Math.round(-2.5) + " " + Math.round(-2.6) + " " + Math.round(0.49999999999999994) + " " + Math.round(-0.4) + " " + Math.round() + " " + Math.round(1e300));
trace("floor " + Math.floor(-1.5) + " " + Math.floor(1.5) + " ceil " + Math.ceil(-1.5) + " " + Math.ceil(1.2) + " " + Math.ceil(-0.5) + " " + Math.floor());
trace("pow " + Math.pow(2, 10) + " " + Math.pow(2) + " " + Math.pow(0/0, 0) + " " + Math.pow(-8, 1/3) + " " + Math.pow() + " " + Math.pow(2, 3.5));
var r = Math.random();
trace("random " + (r >= 0 && r < 1) + " " + typeof r + " " + typeof Math.random(5));
trace("random action " + typeof __op("RandomNumber", 10) + " " + (__op("RandomNumber", 10) < 10) + " " + __op("RandomNumber", 0) + " " + __op("RandomNumber", -5) + " " + __op("RandomNumber", 1) + " " + __op("RandomNumber", "x") + " " + __op("RandomNumber", 0/0) + " " + (__op("RandomNumber", 2147483648) >= 0));
trace("Math " + typeof Math + " " + Math + " " + (Math.constructor == Object) + " " + (Math.__proto__ == Object.prototype));
Math.PI = 3; trace("readonly PI " + Math.PI);
Math.abs = 5; trace("readonly abs " + typeof Math.abs);
trace("delete " + (delete Math.sin));
trace("call " + Math.abs.call(null, -2) + " " + Math.max.apply(null, [1, 5, 3]));
var m = new Math(); trace("new Math " + typeof m);
trace("typeof fn " + typeof Math.abs + " " + typeof Object + " " + typeof function () {});
trace("math arity " + Math.sin() + " " + Math.abs(1, 2) + " " + typeof Math.random(1) + " " + Math.pow(2) + " " + Math.atan2(1) + " " + Math.max(1) + " " + Math.floor());
var noisy = {valueOf: function () { trace("valueOf"); return 2; }};
trace("both converted " + Math.abs(noisy, noisy) + " " + Math.sin(1, noisy));
