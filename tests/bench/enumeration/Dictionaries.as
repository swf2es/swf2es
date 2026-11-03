// Strong Dictionary keys at several sizes, stable or replacing one key before each walk.
import flash.utils.Dictionary;

var checksum:Number = 0;

function keys(x:Dictionary):int {
  var count:int = 0;
  for (var key:* in x) {
    count++;
  }

  return count;
}

function values(x:Dictionary):int {
  var count:int = 0;
  for each (var value:* in x) {
    count++;
  }

  return count;
}

function one(size:int, kind:String, each:Boolean, churn:Boolean):void {
  var dictionary:Dictionary = new Dictionary();
  var ring:Array = [];
  for (var i:int = 0; i < size * 2; i++) {
    var key:* = kind == "strings" || (kind == "mixed" && i % 2) ? "key" + i : {};
    ring.push(key);
    if (i < size) {
      dictionary[key] = i;
    }
  }

  var cursor:int = 0;
  var rounds:int = Math.max(64, int(2097152 / size));
  var warmup:int = Math.max(16, int(rounds / 4));
  var walk:Function = each ? values : keys;
  var label:String = kind + "-" + size + (each ? "-each" : "-in") + (churn ? "-replace1" : "-stable");
  trace(label, walk(dictionary));

  for (var w:int = 0; w < warmup; w++) {
    if (churn) {
      delete dictionary[ring[cursor]];
      dictionary[ring[(cursor + size) % (size * 2)]] = cursor % size;
      cursor = (cursor + 1) % (size * 2);
    }

    checksum += walk(dictionary);
  }

  var started:Number = new Date().time;
  var count:Number = 0;
  for (var r:int = 0; r < rounds; r++) {
    if (churn) {
      delete dictionary[ring[cursor]];
      dictionary[ring[(cursor + size) % (size * 2)]] = cursor % size;
      cursor = (cursor + 1) % (size * 2);
    }

    count += walk(dictionary);
  }

  trace("time:", label, new Date().time - started);
  trace(label + "-visits", count);
  trace(label + "-after", walk(dictionary));
  checksum += count;
}

for each (var size:int in [64, 1024, 32768]) {
  for each (var kind:String in ["objects", "strings", "mixed"]) {
    one(size, kind, false, false);
    one(size, kind, true, false);
    one(size, kind, false, true);
    one(size, kind, true, true);
  }
}

trace("checked", checksum);
