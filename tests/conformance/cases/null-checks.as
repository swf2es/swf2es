// Null checks: each must throw where avmshell's does, null 1009 and
// undefined 1010, and none may be left out where the value can be either.
import flash.utils.ByteArray;

class Box {
  public var next:Box;
  public var n:int = 1;
  public function get self():Box { return this; }
  public function clear():Box { next = null; return this; }
}

function attempt(label:String, f:Function, ...args):void {
  try {
    trace(label, f.apply(null, args));
  } catch (e:Error) {
    trace(label, e);
  }
}

// The same local used twice, checked once.
function twice(b:Box):int { return b.n + b.n; }
// Checked, then set again.
function reset(b:Box):int { var n:int = b.n; b = b.next; return n + b.n; }
// Checked on one path only before a merge.
function onePath(b:Box, first:Boolean):int {
  var n:int = 0;
  if (first) n = b.n;
  return n + b.n;
}
// Compared with null, then used where it is not.
function guarded(b:Box):int { if (b != null) return b.n; return -1; }
function guardedOr(b:Box):int { return (b == null || b.n == 0) ? -1 : b.n + 1; }
function truthy(o:Object):Object { if (o) return o.n; return o.n; }
// Strictly unequal to null may still be undefined.
function strict(o:*):Object { if (o !== null) return o.n; return "null"; }
// A native's :void result, compared as undefined, tells nothing.
function voidResult(b:Box, ba:ByteArray):int { if (b != ba.writeInt(1)) return b.n; return 0; }
function strictUndefined(o:*):Object { if (o !== undefined) return o.n; return "undefined"; }
// A field read again after a call that clears it.
function field(b:Box):int { var n:int = b.next.n; b.clear(); return n + b.next.n; }
// A local the catch sees as it was where the try threw.
function caught(b:Box):String {
  var c:Box = null;
  try {
    c = b;
    c = c.next;
    return "fell through " + c.n;
  } catch (e:Error) {
    return "caught " + e.errorID + " " + c.n;
  }
  return "";
}
// A local an inner function sets: the activation's, read again.
function closure(b:Box):int {
  var clear:Function = function():void { b = null; };
  var n:int = b.n;
  clear();
  return n + b.n;
}
// In a with scope, the name is found on the object.
function within(b:Box):int {
  var o:Object = {n: 5};
  with (o) {
    return n + b.n;
  }
}
// A loop that sets the local on its way round.
function loop(b:Box):int {
  var sum:int = 0;
  while (b != null) {
    sum += b.n;
    b = b.next;
  }
  return sum + b.n;
}
function loopDo(b:Box):int {
  var sum:int = 0;
  do {
    sum += b.n;
    b = b.next;
  } while (sum < 10);
  return sum;
}
function methodOn(b:Box):int { return b.self.self.n; }
function untyped(o:*):* { var x:* = o; x.toString(); return x.length; }

var chain:Box = new Box();
chain.next = new Box();
chain.next.n = 2;
attempt("twice", twice, chain);
attempt("twice null", twice, null);
attempt("reset", reset, chain);
attempt("reset end", reset, chain.next);
attempt("onePath", onePath, chain, true);
attempt("onePath null", onePath, null, false);
attempt("guarded", guarded, chain);
attempt("guarded null", guarded, null);
attempt("guardedOr", guardedOr, chain);
attempt("guardedOr null", guardedOr, null);
attempt("truthy", truthy, chain);
attempt("truthy null", truthy, null);
attempt("truthy undefined", truthy, undefined);
attempt("truthy zero", truthy, 0);
attempt("strict", strict, chain);
attempt("strict null", strict, null);
attempt("strict undefined", strict, undefined);
attempt("voidResult", voidResult, chain, new ByteArray());
attempt("voidResult null", voidResult, null, new ByteArray());
attempt("strictUndefined null", strictUndefined, null);
attempt("strictUndefined undefined", strictUndefined, undefined);
var cleared:Box = new Box();
cleared.next = new Box();
attempt("field", field, cleared);
attempt("caught", caught, chain);
attempt("caught end", caught, chain.next);
attempt("caught null", caught, null);
attempt("closure", closure, chain);
attempt("within", within, chain);
attempt("within null", within, null);
attempt("loop", loop, chain);
attempt("loopDo", loopDo, chain);
attempt("methodOn", methodOn, chain);
attempt("methodOn null", methodOn, null);
attempt("untyped", untyped, "abc");
attempt("untyped null", untyped, null);
attempt("untyped undefined", untyped, undefined);
