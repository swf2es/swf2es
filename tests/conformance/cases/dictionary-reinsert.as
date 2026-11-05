// A key deleted from a Dictionary and added again is walked once, weak or
// strong, however often it comes back, and a for-in that deletes each key
// and adds it again goes through each once.
import flash.utils.Dictionary;

function count(d:Dictionary):int {
  var n:int = 0;
  for (var k:* in d) {
    n++;
  }

  return n;
}

function drain(d:Dictionary, keys:Array):int {
  for (var i:int = 0; i < keys.length; i++) {
    d[keys[i]] = i;
  }

  var n:int = 0;
  for (var k:* in d) {
    delete d[k];
    n++;
  }

  return n;
}

for each (var weak:Boolean in [false, true]) {
  var d:Dictionary = new Dictionary(weak);
  var a:Object = {};
  var b:Object = {};
  d[a] = 1;
  d[b] = 2;
  trace(weak, "before", count(d));

  delete d[a];
  d[a] = 3;
  trace(weak, "added again", count(d), d[a]);

  for (var i:int = 0; i < 3; i++) {
    delete d[a];
    delete d[b];
    d[a] = 1;
    d[b] = 2;
  }

  trace(weak, "churned", count(d));

  var seen:int = 0;
  for (var k:* in d) {
    seen += d[k];
    delete d[k];
    d[k] = 10;
  }

  trace(weak, "added again during a walk", seen, count(d));

  var keys:Array = [];
  for (var j:int = 0; j < 100; j++) {
    keys.push({id: j});
  }

  var drained:int = 0;
  for (var round:int = 0; round < 50; round++) {
    drained += drain(d, keys);
  }

  trace(weak, "drained", drained, count(d));
}
