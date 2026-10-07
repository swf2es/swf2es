// Null checks: each must throw where avmshell's does, null 1009 and
// undefined 1010, and none may be left out where the value can be either.
import flash.utils.ByteArray;

class Box {
  public var next:Box;
  public var n:int = 1;
  public function get self():Box { return this; }
  public function clear():Box { next = null; return this; }
  public function take(b:Box, n:int):int { return n; }
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

// Each kind of instruction with its receiver null or undefined.
interface Named { function get name():String; }
class Named1 implements Named { public function get name():String { return "named"; } }
function getter(b:Box):Box { return b.self; }
function slotSet(b:Box):int { b.n = 3; return b.n; }
function slotGet(b:Box):int { return b.n; }
function call(b:Box):Box { return b.clear(); }
function viaInterface(n:Named):String { return n.name; }
function dynamicGet(o:*, k:String):* { return o[k]; }
function dynamicSet(o:*, k:String):* { o[k] = 1; return o[k]; }
function index(v:Vector.<int>):int { return v[0]; }
function indexSet(v:Vector.<int>):int { v[0] = 7; return v[0]; }
function within2(o:*):Boolean { return "n" in o; }
function remove(o:*):Boolean { return delete o.n; }
function descendants(x:*):* { return x..a; }
function filter(x:*):* { return x.(@a == "1"); }
function callArg(b:Box, v:*):* { return b.next.clear(v as Box); }
function stringMethod(s:String):String { return s.toUpperCase(); }
function coercedArg(o:*, v:*):* { return o.concat(v as Array); }
// The receiver checked, or the arguments converted, first.
function argOrder(b:Box, v:*):int { return b.take(v, v); }

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
for each (var v:* in [null, undefined]) {
  attempt("getter " + v, getter, v);
  attempt("slotSet " + v, slotSet, v);
  attempt("slotGet " + v, slotGet, v);
  attempt("call " + v, call, v);
  attempt("viaInterface " + v, viaInterface, v);
  attempt("dynamicGet " + v, dynamicGet, v, "n");
  attempt("dynamicSet " + v, dynamicSet, v, "n");
  attempt("index " + v, index, v);
  attempt("indexSet " + v, indexSet, v);
  attempt("in " + v, within2, v);
  attempt("delete " + v, remove, v);
  attempt("descendants " + v, descendants, v);
  attempt("filter " + v, filter, v);
  attempt("callArg " + v, callArg, new Box(), v);
  attempt("stringMethod " + v, stringMethod, v);
  attempt("coercedArg " + v, coercedArg, v, [1]);
  attempt("coercedArg arg " + v, coercedArg, v, 5);
  attempt("argOrder " + v, argOrder, v, "x");
  attempt("argOrder arg " + v, argOrder, chain, v);
}
attempt("getter", getter, chain);
attempt("viaInterface", viaInterface, new Named1());
attempt("dynamicSet", dynamicSet, {}, "n");
attempt("indexSet", indexSet, new <int>[1, 2]);
attempt("in", within2, chain);
attempt("descendants", descendants, <r><a>1</a><b><a>2</a></b></r>);
attempt("filter", filter, <r><b a="1"/><b a="2"/></r>.b);
attempt("stringMethod", stringMethod, "abc");
