// for (k in x) and for each (v in x) over the shapes the runtime walks:
// Arrays dense, holey, sparse and with dynamic names, Vectors, Objects,
// Dictionaries, an instance with nothing to walk, nested walks and a walk
// that pushes onto its Array. Each section counts what it goes through, so
// that the counts, not the order of names, are checked against avmshell.
import flash.utils.Dictionary;

class Sealed {
  public var a:int = 1;
  public var b:String = "b";
  public function f():int { return a; }
}

function dense(n:int):Array {
  var a:Array = [];
  for (var i:int = 0; i < n; i++) {
    a.push(i);
  }

  return a;
}

var dense16:Array = dense(16);
var dense1k:Array = dense(1000);
var dense100k:Array = dense(100000);

// Every third element deleted.
var holey:Array = dense(1500);
for (var h:int = 0; h < holey.length; h += 3) {
  delete holey[h];
}

// A thousand elements 10000 apart.
var sparse:Array = [];
for (var s:int = 0; s < 1000; s++) {
  sparse[s * 10000] = s;
}

var named:Array = dense(1000);
named.alpha = 1;
named.beta = 2;
named.gamma = 3;
named.delta = 4;

var ints:Vector.<int> = new Vector.<int>();
var numbers:Vector.<Number> = new Vector.<Number>();
var objects:Vector.<Object> = new Vector.<Object>();
var strings:Vector.<String> = new Vector.<String>();
for (var v:int = 0; v < 1000; v++) {
  ints.push(v);
  numbers.push(v + 0.5);
  objects.push({});
  strings.push("s" + v);
}

function plain(n:int):Object {
  var o:Object = {};
  for (var i:int = 0; i < n; i++) {
    o["p" + i] = i;
  }

  return o;
}

var object16:Object = plain(16);
var object1k:Object = plain(1000);

var objectKeys:Dictionary = new Dictionary();
var stringKeys:Dictionary = new Dictionary();
for (var d:int = 0; d < 1000; d++) {
  objectKeys[{}] = d;
  stringKeys["k" + d] = d;
}

var nest:Array = dense(64);
var sealed:Sealed = new Sealed();

function keys(x:*):int {
  var n:int = 0;
  for (var k:* in x) {
    n++;
  }

  return n;
}

function values(x:*):int {
  var n:int = 0;
  for each (var e:* in x) {
    n++;
  }

  return n;
}

function nestedKeys(a:Array):int {
  var n:int = 0;
  for (var k:* in a) {
    for (var j:* in a) {
      n++;
    }
  }

  return n;
}

function nestedValues(a:Array):int {
  var n:int = 0;
  for each (var e:* in a) {
    for each (var f:* in a) {
      n++;
    }
  }

  return n;
}

// As a FlashPunk world adds what it queued: what it adds queues more, then
// the queue is emptied.
var queue:Array = [];

function queuedKeys():int {
  var n:int = 0;
  for (var i:int = 0; i < 16; i++) {
    queue.push(i);
  }

  for (var k:* in queue) {
    n++;
    if (queue.length < 1000) {
      queue.push(n);
    }
  }

  queue.length = 0;
  return n;
}

function queuedValues():int {
  var n:int = 0;
  for (var i:int = 0; i < 16; i++) {
    queue.push(i);
  }

  for each (var e:* in queue) {
    n++;
    if (queue.length < 1000) {
      queue.push(n);
    }
  }

  queue.length = 0;
  return n;
}

var checksum:Number = 0;

function bench(name:String, rounds:int, f:Function, x:*):void {
  trace(name, f(x));
  for (var warm:int = 0; warm < rounds / 10; warm++) {
    checksum += f(x);
  }

  var started:Number = new Date().time;
  for (var j:int = 0; j < rounds; j++) {
    checksum += f(x);
  }

  trace("time:", name, new Date().time - started);
}

function both(name:String, rounds:int, x:*):void {
  bench(name + "-in", rounds, keys, x);
  bench(name + "-each", rounds, values, x);
}

both("dense16", 200000, dense16);
both("dense1k", 4000, dense1k);
both("dense100k", 40, dense100k);
both("holey", 4000, holey);
both("sparse", 2000, sparse);
both("named", 4000, named);
both("vector-int", 4000, ints);
both("vector-number", 4000, numbers);
both("vector-object", 4000, objects);
both("vector-string", 4000, strings);
both("object16", 200000, object16);
both("object1k", 2000, object1k);
both("dict-objects", 2000, objectKeys);
both("dict-strings", 2000, stringKeys);
both("sealed", 1000000, sealed);
bench("nested-in", 1000, nestedKeys, nest);
bench("nested-each", 1000, nestedValues, nest);
bench("queue-in", 1000, function(x:*):int { return queuedKeys(); }, null);
bench("queue-each", 1000, function(x:*):int { return queuedValues(); }, null);
trace("checked", checksum);
