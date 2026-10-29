package {
  // A comparator that sorts inside itself, keeps its arguments, takes them as rest, and the
  // fields of sortOn with their options: each call's arguments its own, whatever the sort keeps.
  var inner:Array = [];
  var kept:Array = [];
  var rests:Array = [];

  function nested(a:*, b:*):int {
    var other:Array = [3, 1, 2];
    other.sort(function (x:*, y:*):int { return x - y; });
    inner.push(other.join(""));
    kept.push(arguments);
    return a - b;
  }

  var numbers:Array = [5, 3, 9, 1, 7];
  numbers.sort(nested);
  trace(numbers.join(","), inner[0], inner.length > 0);
  var seen:Array = [];
  for each (var args:* in kept) {
    seen.push(args[0] + ":" + args[1]);
  }
  trace(seen.join(" "));

  function rest(...pair):int {
    rests.push(pair);
    return pair[0] - pair[1];
  }

  var three:Array = [4, 2, 8, 6];
  three.sort(rest);
  var pairs:Array = [];
  for each (var p:* in rests) {
    pairs.push(p.join(":"));
  }
  trace(three.join(","), pairs.join(" "));

  // The same array sorted again from its own comparator.
  var self:Array = [3, 1, 2];
  var depth:int = 0;
  self.sort(function (a:*, b:*):int {
    if (depth++ === 0) {
      self.sort(Array.NUMERIC | Array.DESCENDING);
    }
    return a - b;
  });
  trace(self.join(","), depth > 0);

  var objects:Array = [{a: 2, b: "x"}, {a: 1, b: "Y"}, {a: 2, b: "a"}, {a: 10, b: "b"}];
  objects.sortOn(["a", "b"]);
  trace(objects.map(function (o:*, i:int, all:Array):String { return o.a + o.b; }).join(","));
  objects.sortOn(["a", "b"], [Array.NUMERIC | Array.DESCENDING, Array.CASEINSENSITIVE]);
  trace(objects.map(function (o:*, i:int, all:Array):String { return o.a + o.b; }).join(","));
  trace(objects.sortOn("a", Array.NUMERIC | Array.RETURNINDEXEDARRAY).join(","));
  var v:Vector.<Number> = Vector.<Number>([2.5, -1, 9, 0.5]);
  v.sort(function (x:Number, y:Number):Number { return y - x; });
  trace(v.join(","));
}
