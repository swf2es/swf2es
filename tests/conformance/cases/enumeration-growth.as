// A for-in or for each over an Array or a Vector goes on through the
// elements pushed during it, as avmplus walks them by their live length.

function eachPushing(a:*, limit:int):String {
  var seen:Array = [];
  for each (var x:* in a) {
    seen.push(x);
    if (x < limit) {
      a.push(x + 2);
    }
  }
  return seen.join(",");
}

function namesPushing(a:*, until:int):String {
  var seen:Array = [];
  for (var k:* in a) {
    seen.push(k);
    if (a.length < until) {
      a.push(0);
    }
  }
  return seen.join(",");
}

trace("array each", eachPushing([1, 2], 6));
trace("array names", namesPushing([7, 8], 5));
trace("vector int", eachPushing(new <int>[1, 2], 6));
trace("vector Number", eachPushing(new <Number>[1.5, 2.5], 6));
trace("vector Object", eachPushing(new <Object>[1, 2], 6));
trace("vector names", namesPushing(new <String>["a", "b"], 4));

// As a world that adds what is queued, each added thing queuing more, then
// empties the queue: everything queued during the walk is added too.
var queue:Array = ["world"];
var added:Array = [];
for each (var thing:String in queue) {
  added.push(thing);
  if (thing == "world") {
    queue.push("screen");
  } else if (thing == "screen") {
    queue.push("button1", "button2");
  }
}
queue.length = 0;
trace("queue", added.join(","), queue.length);

// An element written past the end, leaving a hole, is reached; the hole is not.
var holes:Array = [1];
var holeSeen:Array = [];
for (var h:* in holes) {
  holeSeen.push(h);
  if (holes.length == 1) {
    holes[3] = 4;
  }
}
trace("holes", holeSeen.join(","));

// A for-in inside another over the same Array: both go through what the inner one pushes.
var nested:Array = [1, 2];
var outer:Array = [];
var inner:Array = [];
for each (var o:int in nested) {
  outer.push(o);
  if (o == 1) {
    for each (var i:int in nested) {
      inner.push(i);
      if (i == 2) {
        nested.push(3);
      }
    }
  }
}
trace("nested", outer.join(","), inner.join(","));

// Elements pushed once the walk has passed the end are not reached.
var after:Array = [1, 2];
var afterSeen:Array = [];
for each (var y:int in after) {
  afterSeen.push(y);
}
after.push(3);
trace("after", afterSeen.join(","), after.length);

// Shrinking and growing again during a for each.
var shrink:Array = [1, 2, 3, 4];
var shrinkSeen:Array = [];
for each (var z:int in shrink) {
  shrinkSeen.push(z);
  if (z == 2) {
    shrink.length = 1;
    shrink.push(5, 6, 7);
  }
}
trace("shrink", shrinkSeen.join(","));

// Past the elements come the other names, their indices after the elements'
// length: one pushed while at the only dynamic name moves that name back
// under the walk, which goes through it again and never reaches the push,
// even past a for-in inside it that went through everything, and past a
// name deleted before.
var named:Array = [1, 2];
named.gone = 1;
named.kept = 1;
delete named.gone;
var namedSeen:Array = [];
var pushed:Boolean = false;
for (var n:* in named) {
  namedSeen.push(n);
  if (n == "kept" && !pushed) {
    pushed = true;
    named.push(3);
    var within:Array = [];
    for (var w:* in named) {
      within.push(w);
    }
    trace("named inner", within.join(","));
  }
}
trace("named", namedSeen.join(","));

// Pushed while still in the elements, it comes before the dynamic names.
var mixed:Array = [1, 2];
mixed.x = 1;
var mixedSeen:Array = [];
for (var m:* in mixed) {
  mixedSeen.push(m);
  if (m == 0) {
    mixed.push(3);
  }
}
trace("mixed", mixedSeen.join(","));

// A dynamic name added during the elements is reached too.
var later:Array = [1, 2];
var laterSeen:Array = [];
for (var l:* in later) {
  laterSeen.push(l);
  if (l == 0) {
    later.w = 1;
  }
}
trace("later name", laterSeen.join(","));

// A hole filled in ahead of the walk is reached in its place.
var filled:Array = [];
filled[0] = 1;
filled[2] = 3;
var filledSeen:Array = [];
for (var f:* in filled) {
  filledSeen.push(f);
  if (f == 0) {
    filled[1] = 2;
  }
}
trace("filled", filledSeen.join(","));

var refilled:Array = [1, 2, 3, 4];
delete refilled[1];
var refilledSeen:Array = [];
for each (var r:int in refilled) {
  refilledSeen.push(r);
  if (r == 1) {
    refilled[1] = 9;
  }
}
trace("refilled", refilledSeen.join(","));

// Elements far apart, and one written far out during the walk.
var far:Array = [];
far[0] = 1;
far[5000] = 2;
far[100000000] = 3;
var farSeen:Array = [];
for each (var v:int in far) {
  farSeen.push(v);
  if (v == 1) {
    far[200000000] = 4;
  }
}
trace("far", farSeen.sort().join(","));
