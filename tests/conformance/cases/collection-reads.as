var methods:Array = ["map", "filter", "forEach", "every", "some"];
var seen:Array;

function answer(method:String, value:*):* {
  return method == "some" ? false : method == "map" ? value : true;
}

function arrays(method:String, change:Boolean):void {
  var input:Array = [1, 2, 3];
  delete input[1];
  Array.prototype[1] = 7;
  seen = [];
  var result:* = input[method](function(value:*, index:int, source:Array):* {
    seen.push(index + ":" + value);
    if (change && index == 0) {
      source.length = 0;
      source.push(8, 9);
    }

    return answer(method, value);
  });
  delete Array.prototype[1];
  trace("array", method, change, seen, result, input);
}

function vectors(method:String, grow:Boolean):void {
  var input:Vector.<int> = new <int>[1, 2, 3];
  seen = [];
  try {
    var result:* = input[method](function(value:int, index:int, source:Vector.<int>):* {
      seen.push(index + ":" + value);
      if (index == 0) {
        source.length = 0;
        if (grow) {
          source.push(8, 9, 10, 11);
        }
      }

      return answer(method, value);
    });
    trace("vector", method, grow, seen, result, input);
  } catch (e:Error) {
    trace("vector", method, grow, seen, "error", e.errorID, input);
  }
}

for each (var method:String in methods) {
  arrays(method, false);
  arrays(method, true);
  vectors(method, false);
  vectors(method, true);
}

for each (method in ["some", "every"]) {
  var short:Vector.<int> = new <int>[1, 2];
  seen = [];
  trace("short circuit", method, short[method](function(value:int, index:int, source:Vector.<int>):Boolean {
    seen.push(value);
    source.length = 0;
    return method == "some";
  }), seen);
}

var numbers:Vector.<Number> = new <Number>[-0, NaN, Infinity];
trace("numeric values", numbers.map(function(value:Number, index:int, source:Vector.<Number>):Number {
  return 1 / value;
}));

var sparse:Array = [3, 2, 1];
delete sparse[1];
Array.prototype[1] = 4;
sparse.sort(Array.NUMERIC);
delete Array.prototype[1];
trace("sparse sort", sparse, sparse.hasOwnProperty("0"), sparse.hasOwnProperty("1"), sparse.hasOwnProperty("2"));

var sorted:Vector.<int> = new <int>[3, 1, 2];
var first:Boolean = true;
sorted.sort(function(a:int, b:int):Number {
  if (first) {
    first = false;
    sorted.length = 0;
    sorted.push(99, 98, 97);
  }

  return a - b;
});
trace("sort storage replaced", sorted);

var people:Array;
class Ranked {
  public var name:String;
  private var rank:Number;

  public function Ranked(name:String, rank:Number) {
    this.name = name;
    this.rank = rank;
  }

  public function get key():Number {
    seen.push(name);
    if (name == "c") {
      people[1] = new Ranked("replacement", 9);
    }

    return rank;
  }
}

people = [new Ranked("a", 1), new Ranked("b", 2), new Ranked("c", 3)];
seen = [];
people.sortOn("key", Array.NUMERIC);
trace("sortOn getter order", seen);
trace("sortOn changed element", people.map(function(value:Ranked, index:int, source:Array):String {
  return value.name;
}));
