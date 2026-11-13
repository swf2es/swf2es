// An Array whose elements are far apart, changed during a for-in over it
// and between two. avmshell keeps such an Array's elements in a hashtable
// and walks it in the table's order, reaching an element added during the
// walk or not by where it hashes: only what any order gives is traced,
// sorted. A walk that starts after a change goes through exactly what is
// there then.

dynamic class Sub extends Array {
}

function spread(n:int, gap:int):Array {
  var a:Array = [];
  for (var i:int = 0; i < n; i++) {
    a[i * gap] = i;
  }

  return a;
}

function names(x:*):String {
  var seen:Array = [];
  for (var k:* in x) {
    seen.push(int(k));
  }

  seen.sort(Array.NUMERIC);
  return seen.join(",");
}

function values(x:*):String {
  var seen:Array = [];
  for each (var v:* in x) {
    seen.push(String(v));
  }

  seen.sort();
  return seen.join(",");
}

// Those of `seen` that were there from the start, each once however often
// it was seen: avmshell's table, grown by what a walk adds, is laid out
// anew, and the walk goes through some of it again.
function originals(seen:Array, gap:int):String {
  var kept:Array = [];
  for (var i:int = 0; i < seen.length; i++) {
    if (int(seen[i]) % gap == 0 && kept.indexOf(int(seen[i])) < 0) {
      kept.push(int(seen[i]));
    }
  }

  kept.sort(Array.NUMERIC);
  return kept.join(",");
}

// Pushed onto at every step: those there from the start are each gone through.
var pushed:Array = spread(8, 1000);
var seen:Array = [];
for (var k:* in pushed) {
  seen.push(k);
  if (pushed.length < 7100) {
    pushed.push("pushed");
  }
}
trace("push", originals(seen, 1000), pushed.length);
trace("push after", names(pushed));

// The element a step gave deleted at that step: every one is still gone through.
var behind:Array = spread(8, 1000);
seen = [];
for (k in behind) {
  seen.push(k);
  delete behind[k];
}
trace("delete behind", originals(seen, 1000), behind.length, names(behind) == "");

seen = [];
behind = spread(8, 1000);
for each (var v:* in behind) {
  seen.push(v);
  delete behind[v * 1000];
}
seen.sort(Array.NUMERIC);
trace("delete behind each", seen.join(","), values(behind) == "");

// All but the one the first step gave deleted: no step follows the first.
var ahead:Array = spread(8, 1000);
var steps:int = 0;
for (k in ahead) {
  steps++;
  if (steps == 1) {
    for (var d:int = 0; d < 8000; d += 1000) {
      if (d != int(k)) {
        delete ahead[d];
      }
    }
  }
}
trace("delete ahead", steps, names(ahead).split(",").length);

// The length cut to nothing at the first step, and at a later one.
var cut:Array = spread(8, 1000);
steps = 0;
for (k in cut) {
  steps++;
  cut.length = 0;
}
trace("length 0", steps, cut.length, names(cut) == "");

cut = spread(8, 1000);
steps = 0;
for each (v in cut) {
  steps++;
  if (steps == 3) {
    cut.length = 0;
  }
}
trace("length 0 at third", steps, cut.length);

// The length cut below the upper half at the first step: the lower half,
// there throughout, is gone through, but for the first step's own if it was
// in the upper.
var halved:Array = spread(8, 1000);
seen = [];
for (k in halved) {
  if (seen.length == 0) {
    halved.length = 3500;
  }
  if (int(k) < 3500) {
    seen.push(k);
  }
}
trace("length cut", originals(seen, 1000), halved.length, names(halved));

// The length grown without an element added: nothing more to go through.
var grown:Array = spread(8, 1000);
seen = [];
for (k in grown) {
  seen.push(k);
  grown.length += 100000;
}
trace("length grown", originals(seen, 1000), grown.length);

// Reversed at the first step: the elements keep the same indices here, six
// apart evenly, and each is gone through. What reverse leaves in the holes
// is not traced.
var reversed:Array = spread(6, 1000);
seen = [];
for (k in reversed) {
  if (seen.length == 0) {
    reversed.reverse();
  }
  seen.push(k);
}
trace("reversed", originals(seen, 1000), reversed.length);

// A walk inside each step of another over the same Array, the inner one
// left off at its third step; then one inside that.
var nest:Array = spread(7, 3000);
var outer:int = 0;
var inner:int = 0;
var innermost:int = 0;
for (var k1:* in nest) {
  outer++;
  var third:int = 0;
  for (var k2:* in nest) {
    inner++;
    if (++third == 3) {
      break;
    }
    for each (var v3:* in nest) {
      innermost++;
    }
  }
}
trace("nested", outer, inner, innermost);

// A walk left off, then others from the start: each goes through everything.
var left:Array = spread(9, 2500);
steps = 0;
for (k in left) {
  if (++steps == 4) {
    break;
  }
}
trace("left off", steps, names(left), values(left));
steps = 0;
for each (v in left) {
  if (++steps == 2) {
    break;
  }
}
trace("left off each", steps, values(left), names(left));

// Changed between walks: a hole filled below the length, an element
// deleted, both at once so that as many are there as before, one written
// past the end, the length cut and a property named.
var between:Array = spread(6, 1000);
trace("before", names(between));
between[2500] = "filled";
trace("filled", names(between), values(between));
delete between[3000];
trace("deleted", names(between));
delete between[0];
between[1] = "swapped";
trace("swapped", names(between), values(between));
between[90000] = "far";
trace("past the end", names(between), between.length);
between.length = 4500;
trace("cut", names(between), between.length);
between.note = "named";
trace("named", values(between));

// The same walk over and over, a hole filled between two: the walk after
// goes through it.
var again:Array = spread(40, 500);
var counts:Array = [];
for (var round:int = 0; round < 6; round++) {
  var n:int = 0;
  for (k in again) {
    n++;
  }
  counts.push(n);
  again[round * 500 + 7] = round;
  if (round == 3) {
    delete again[1500];
    delete again[2000];
  }
}
trace("again", counts.join(","), names(again).split(",").length);

// Thirty elements side by side, then others far off: a walk by index, then
// by the Array's indices.
var mixed:Array = [];
for (var m:int = 0; m < 30; m++) {
  mixed[m] = m;
}
mixed[5000] = "a";
mixed[70000] = "b";
mixed.setPropertyIsEnumerable("70000", false);
trace("mixed", names(mixed), values(mixed));
mixed.setPropertyIsEnumerable("70000", true);
trace("mixed shown", names(mixed).split(",").length, values(mixed).split(",").length);

// An element that is undefined, and a subclass of Array.
var holding:Array = spread(5, 4000);
holding[6000] = undefined;
holding[10000] = null;
trace("undefined", names(holding), values(holding));

var sub:Sub = new Sub();
for (var s:int = 0; s < 5; s++) {
  sub[s * 3000] = "s" + s;
}
sub.note = "n";
trace("subclass", names(sub), values(sub), sub.length);
