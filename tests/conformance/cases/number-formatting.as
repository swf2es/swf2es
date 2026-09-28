// Numbers written as avmplus writes them, across the range of doubles:
// toString, toFixed, toPrecision, toExponential and other radixes. The
// values come from integer arithmetic and single divisions and
// multiplications, which round alike everywhere.
var seed:uint = 12345;
function next():uint {
  seed = uint(seed * 1103515245 + 12345) & 0x7fffffff;
  return seed;
}
var scales:Array = [];
var p:Number = 1;
for (var k:int = 0; k < 30; k++) { scales.push(p); p *= 1000; }
var q:Number = 1;
for (k = 0; k < 30; k++) { q /= 1000; scales.push(q); }
for (var i:int = 0; i < 240; i++) {
  var v:Number = next() / (next() % 9973 + 1) * scales[i % scales.length];
  if (i % 7 == 3) v = -v;
  var line:String = String(v);
  if (Math.abs(v) < 1e21) line += " " + v.toFixed(i % 21);
  line += " " + v.toPrecision(1 + i % 21) + " " + v.toExponential(i % 21);
  // Above 2^53, avmshell's radix digits depend on its x87 arithmetic (it
  // is a 32-bit x86 build), and are garbage anyway: see docs/architecture.md.
  if (i % 5 == 0 && Math.abs(v) < 9007199254740992) line += " " + v.toString(2 + i % 35);
  trace(line);
}
trace(Number.MAX_VALUE, -Number.MIN_VALUE, 2.2250738585072014e-308, 9007199254740993, 0.1 + 0.7);
trace((0).toFixed(3), (0).toPrecision(3), (0).toExponential(3), (-1.5).toFixed(0), (2.5).toFixed(0), (1.005).toFixed(2));
trace((123.456).toFixed(10), (1e-10).toFixed(20), (0.000001).toPrecision(2), (123456789).toPrecision(3));
