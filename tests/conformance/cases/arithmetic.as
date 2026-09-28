// Arithmetic and comparison on mixed types: add, the numeric operators,
// the int and uint operators, increments, and the relational operators.
var n:Number = 7, i:int = -7, u:uint = 7, s:String = "3", b:Boolean = true;
var o:Object = null, x:* = undefined;
trace("add", n + s, s + n, n + b, b + b, o + 1, x + 1, "a" + o, "a" + x);
trace("sub", s - 1, "x" - 1, b - o, n - i);
trace("mul", s * 2, n * -0, 1 / (n * -0), 0 / 0);
trace("div", 7 / 2, i / 2, int(i / 2), -7 % 3, 7 % -3, 5.5 % 2, 1 % 0);
trace("int ops", i >> 1, i >>> 1, i << 31, u >>> 0, ~u, ~i, i & 0xff, i | 0x100, i ^ 3);
var big:int = 2147483647;
big++;
var small:uint = 0;
small--;
trace("wrap", big, small, big * 2, -big);
var k:int = 5;
trace("incdec", k++, k, ++k, k--, --k, k);
trace("compare", 1 < 2, "10" < "9", 10 < "9", "a" < "b", NaN < 1, NaN >= 1, null < 1, undefined < 1);
trace("equals", 1 == "1", null == undefined, null == 0, "" == 0, true == 1, "1" === 1, NaN == NaN);
trace("unary", -s, +s, +"", +" 12 ", +"0x1A", +"1e3", +"abc", -"-5");
trace("not", !0, !"", !"a", !null, !NaN, !{});
