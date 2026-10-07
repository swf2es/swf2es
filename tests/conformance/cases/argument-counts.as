// The count of arguments a method takes: ArgumentError 1063 for too few,
// or too many where it takes no rest, whatever its optional parameters.
class Counted {
  public function none():int { return 0; }
  public function one(a:int):int { return a; }
  public function range(a:int, b:int = 2, c:int = 3):int { return a + b + c; }
  public function optional(a:int = 1, b:int = 2):int { return a + b; }
  public function rest(a:int, ...more):int { return a + more.length; }
  public function restOnly(...more):int { return more.length; }
  public function untyped(a, b) { return String(a) + String(b); }
}

var counted:Counted = new Counted();
var closure:Function = function(a:int, b:int = 5):int { return a + b; };
var bare:Function = function(a, b) { return a; };
var methods:Array = [
  ["none", counted.none],
  ["one", counted.one],
  ["range", counted.range],
  ["optional", counted.optional],
  ["rest", counted.rest],
  ["restOnly", counted.restOnly],
  ["untyped", counted.untyped],
  ["closure", closure],
  ["bare", bare]
];
for each (var m:Array in methods) {
  for each (var args:Array in [[], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4]]) {
    try {
      trace(m[0], args.length, m[1].apply(null, args));
    } catch (e:ArgumentError) {
      trace(m[0], args.length, e.errorID, e.message);
    }
  }
}
