// toFixed, toPrecision and toExponential where avmplus' rounding and
// JavaScript's part or nearly do: decimal halves and the doubles about
// them, carries across a power of ten, numbers below the last place
// written, zero, and the prices and percentages SWFs format most.
var values:Array = [
  0, 0.5, 1.5, 2.5, 0.05, 0.06, 0.006, 0.0004, 1.005, 1.255, 8.345, 1.45, 0.125, 0.375,
  99.995, 9.99, 9.995, 999, 99999.9, 999999.99, 0.999, 0.0999, 0.00999, 1.31615, 6895.29,
  123.456, 0.1 + 0.2, 0.1 * 3, 1 / 3, 2 / 3, 19.99, 45.5, 12.345, 1234.5678, 0.0000012345,
  1e-7, 1e15, 1e20, 123456789012, 4294967295.5, 1e21 - 65536
];
var lines:Array = [];
for each (var v:Number in values) {
  for each (var n:Number in [v, -v]) {
    var fixed:Array = [];
    var precision:Array = [];
    var exponential:Array = [];
    for (var p:int = 0; p <= 20; p++) {
      if (p % 3 == 0 || p < 5) {
        fixed.push(n.toFixed(p));
        exponential.push(n.toExponential(p));
        precision.push(n.toPrecision(p + 1));
      }
    }
    trace(n, fixed.join(" "));
    trace("  ", precision.join(" "));
    trace("  ", exponential.join(" "));
  }
}
