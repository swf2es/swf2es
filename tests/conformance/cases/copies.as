// Copies of locals, scopes and stack values, read as what they copy: each
// must still give the value it had when copied after its original changes,
// on every path, across branches, loops, handlers and scopes.

// A copy on the stack whose local is set again before it is read.
function reassigned(i:int):void {
  trace("reassigned", i, i = 3, i);
  var a:int = 1;
  trace("postfix", a, a++, a, a--, a);
  var o:Object = "first";
  var s:Object = o;
  o = "second";
  trace("kept", s, o);
}

// The local set on one side of a branch only, the copy read after the merge.
function merged(c:Boolean):void {
  var n:int = 5;
  trace("merged", c, n, c ? (n = 1) : 0, n);
  var m:int = 7;
  trace("both", c, m, c ? (m = 1) : (m = 2), m);
  var k:Object = "k";
  trace("or", (k = c ? null : "set") || k, k);
  trace("and", c && (k = "and"), k);
}

// The local set in a loop the copy is live through.
function looped():void {
  for (var i:int = 0; i < 3; i++) {
    trace("loop", i, i++, i);
  }

  var j:int = 0;
  var total:String = "";
  while (j < 4) {
    total += j + ":" + (j % 2 ? j++ : (j += 2)) + ":" + j + " ";
  }
  trace("while", total);

  var x:Object = "x0";
  var seen:Array = [];
  for (var k:int = 0; k < 3; k++) {
    var before:Object = x;
    x = "x" + (k + 1);
    seen.push(before, x);
  }
  trace("carried", seen.join(","));
}

// A local set in a try, read in its handler and after it.
function caught(fail:Boolean):void {
  var v:int = 1;
  var w:Object = "w0";
  try {
    trace("try", v, v = 2, w, w = "w1");
    if (fail) {
      throw new Error("e" + v);
    }
    v = 3;
  } catch (e:Error) {
    trace("catch", e.message, v, w);
    v = 4;
  } finally {
    trace("finally", v, w);
  }
  trace("after", v, w);
}

// Scopes: an activation, a catch scope and a with scope, each captured.
function scoped(n:int):Array {
  var fs:Array = [];
  for (var i:int = 0; i < n; i++) {
    fs.push(function ():int { return i * 10 + n; });
  }

  try {
    throw new Error("caught");
  } catch (e:Error) {
    fs.push(function ():String { return e.message; });
  }

  var o:Object = {x: "with x"};
  with (o) {
    fs.push(function ():Object { return x; });
  }

  n = 100;
  return fs;
}

// A value set to a local and used again at once.
function assigned():void {
  var a:Object;
  var b:Object;
  a = b = "chained";
  trace("chained", a, b);
  var found:Object;
  var list:Array = [null, "", "third"];
  var at:int = 0;
  while ((found = list[at++]) == null || found == "") {
    trace("skip", found, at);
  }
  trace("found", found, at);
  if ((found = list[0]) != null) {
    trace("never");
  } else {
    trace("null", found);
  }
}

class Counter {
  public var n:int = 0;
  public static var made:int = 0;
  public function Counter() {
    made++;
  }
  public function next():int {
    return n++;
  }
  public function get twice():int {
    var m:int = n;
    n += 2;
    return m;
  }
}

function members():void {
  var c:Counter = new Counter();
  trace("members", c.next(), c.n, c.twice, c.n, c.next() + c.next(), c.n);
  var d:Counter = c;
  c = new Counter();
  trace("instances", d.n, c.n, Counter.made);
}

reassigned(9);
merged(true);
merged(false);
looped();
caught(false);
caught(true);
var fs:Array = scoped(2);
for each (var f:Function in fs) {
  trace("scope", f());
}
assigned();
members();
