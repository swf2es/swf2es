// A hole just after the element a for-in is at, filled during the walk,
// in an Array with a gap too long to step through. Where avmplus keeps the
// Array dense it walks it by index and reaches the element filled in.
// Where it keeps it in a hashtable, whether it does depends on where the
// element hashes, as does the order of the walk: only the elements there
// from the start are traced, sorted.

// Three runs, twenty holes between each: few enough that avmplus keeps
// the Array dense. The walk crosses the first gap by the Array's indices,
// and the hole after the second run is filled when it reaches the run's end.
function gapped():Array {
  var a:Array = [];
  for (var i:int = 0; i < 300; i++) {
    if (i < 100 || (i >= 120 && i < 200) || i >= 220) {
      a[i] = i;
    }
  }

  return a;
}

var dense:Array = gapped();
var denseSeen:Array = [];
for (var k:* in dense) {
  denseSeen.push(k);
  if (k == 199) {
    dense[200] = "filled";
  }
}
trace("dense", denseSeen.length, denseSeen.indexOf(200) >= 0, denseSeen[180]);

dense = gapped();
var denseValues:Array = [];
for each (var v:* in dense) {
  denseValues.push(v);
  if (v == 199) {
    dense[200] = "filled";
  }
}
trace("dense each", denseValues.length, denseValues[180]);

// Six elements a thousand apart: avmplus keeps them in its hashtable.
function spread():Array {
  var a:Array = [];
  for (var i:int = 0; i < 6; i++) {
    a[i * 1000] = i;
  }

  return a;
}

var sparse:Array = spread();
var original:Array = [];
for (k in sparse) {
  if (int(k) % 1000 == 0) {
    original.push(int(k));
  }
  if (int(k) == 2000) {
    sparse[2001] = "filled";
  }
}
original.sort(Array.NUMERIC);
trace("sparse", original.join(","), sparse.length);

sparse = spread();
var originalValues:Array = [];
for each (v in sparse) {
  if (v is int) {
    originalValues.push(v);
    if (v == 2) {
      sparse[2001] = "filled";
    }
  }
}
originalValues.sort(Array.NUMERIC);
trace("sparse each", originalValues.join(","));
