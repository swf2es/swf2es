// for-in and for each over Arrays whose elements are far apart, so that a
// walk crosses each gap by the Array's indices: walks inside walks over the
// same Array and over another, a walk left off inside another, elements
// hidden or deleted during a walk, and the names and prototypes after the
// elements. avmshell keeps such an Array's elements in a hashtable, whose
// order is not the elements', so only what a walk goes through is traced,
// sorted, not the order it goes through it in.

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
    seen.push(String(k));
  }

  seen.sort();
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

var a:Array = spread(6, 1000);
trace("names", names(a));
trace("values", values(a));

// Each step of the outer walk goes on from where it was, after a whole walk
// over the same Array inside it.
var pairs:int = 0;
var outer:int = 0;
for (var k1:* in a) {
  outer++;
  for (var k2:* in a) {
    pairs++;
  }
}
trace("nested", outer, pairs);

var eachPairs:int = 0;
for each (var v1:* in a) {
  for each (var v2:* in a) {
    eachPairs++;
  }
}
trace("nested each", eachPairs);

// A walk left off after its first step inside each step of the outer one.
var leftOff:int = 0;
var firsts:int = 0;
for (var k3:* in a) {
  leftOff++;
  for (var k4:* in a) {
    firsts++;
    break;
  }
}
trace("left off", leftOff, firsts);

// Steps over two Arrays taken in turn.
var b:Array = spread(4, 5000);
var crossed:int = 0;
for (var k5:* in a) {
  for (var k6:* in b) {
    crossed++;
  }
}
trace("two arrays", crossed);

// Every other element deleted, or hidden, at the first step: only that one is gone through.
var deleting:Array = spread(8, 1000);
var deletingSeen:int = 0;
for (var k7:* in deleting) {
  deletingSeen++;
  if (deletingSeen == 1) {
    for (var d:int = 0; d < 8000; d += 1000) {
      if (d != int(k7)) {
        delete deleting[d];
      }
    }
  }
}
trace("deleted", deletingSeen, names(deleting).split(",").length);

var hiding:Array = spread(8, 1000);
var hidingSeen:int = 0;
for (var k8:* in hiding) {
  hidingSeen++;
  if (hidingSeen == 1) {
    for (var h:int = 0; h < 8000; h += 1000) {
      if (h != int(k8)) {
        hiding.setPropertyIsEnumerable(String(h), false);
      }
    }
  }
}
trace("hidden", hidingSeen, names(hiding).split(",").length, hiding.length);

// After the elements, the Array's other names, then its prototype's.
var named:Array = spread(5, 2000);
named.note = "n";
Array.prototype[3] = "p";
trace("named", names(named), values(named));
delete Array.prototype[3];
trace("named again", names(named), values(named));
