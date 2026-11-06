// An Array with gaps too long to step through, so that a for-in crosses
// them by the Array's indices, grows by many elements just before a gap:
// the walk goes on through all of them, as avmplus walks an Array it keeps
// dense by its length at each step. Only counts are traced.

function gapped():Array {
  var a:Array = [];
  for (var i:int = 0; i < 300; i++) {
    // Two runs of twenty holes: few enough that avmplus keeps the Array dense.
    if (i < 100 || (i >= 120 && i < 200) || i >= 220) {
      a[i] = i;
    }
  }

  return a;
}

var a:Array = gapped();
var seen:int = 0;
for (var k:* in a) {
  seen++;
  if (k == 199) {
    for (var j:int = 0; j < 200000; j++) {
      a.push(j);
    }
  }
}
trace("names", seen, a.length);

var b:Array = gapped();
var values:int = 0;
for each (var v:* in b) {
  values++;
  if (values == 180) {
    for (j = 0; j < 200000; j++) {
      b.push(j);
    }
  }
}
trace("values", values, b.length);
