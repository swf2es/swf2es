var input:Array = [];
for (var i:int = 0; i < 8192; i++) {
  input.push((i * 31337) & 8191);
}
var vector:Vector.<Number> = Vector.<Number>(input);
function identity(x:*, i:int, source:*):* { return x; }
function even(x:*, i:int, source:*):Boolean { return (int(x) & 1) == 0; }
function always(x:*, i:int, source:*):Boolean { return true; }
function never(x:*, i:int, source:*):Boolean { return false; }
var sum:Number = 0;
var checksum:Number = 0;
function count(x:*, i:int, source:*):void { sum += x; }
function bench(name:String, f:Function):void {
  for (var warm:int = 0; warm < 12; warm++) {
    checksum += f();
  }

  var started:Number = new Date().time;
  for (var j:int = 0; j < 80; j++) {
    checksum += f();
  }

  trace("time:", name, new Date().time - started);
}
bench("array-map", function():Number { return input.map(identity).length; });
bench("array-filter", function():Number { return input.filter(even).length; });
bench("array-forEach", function():Number { input.forEach(count); return sum; });
bench("array-every", function():Number { return input.every(always) ? 1 : 0; });
bench("array-some", function():Number { return input.some(never) ? 1 : 0; });
bench("vector-map", function():Number { return vector.map(identity).length; });
bench("vector-filter", function():Number { return vector.filter(even).length; });
bench("array-sort", function():Number { return input.slice().sort(Array.NUMERIC)[0]; });
bench("vector-sort", function():Number { return vector.slice().sort(Array.NUMERIC)[0]; });
bench("vector-convert", function():Number { return Vector.<Number>(input)[4096]; });
trace("checked", sum, checksum, input.length, vector.length, input[0], input[1], vector[1]);
