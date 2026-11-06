// An address out of range at an int or uint address, which the emitter
// loads and stores in place: the RangeError each catcher sees, in the
// method itself, in its caller, through a native that calls back, past a
// finally, and in the script's own code.
import avmplus.Domain;
import flash.utils.ByteArray;
import avm2.intrinsics.memory.*;

var mem:ByteArray = new ByteArray();
mem.length = 1024;
Domain.currentDomain.domainMemory = mem;

function describe(e:*):String {
  return (e is RangeError) + " " + (e is Error ? e.errorID + " " + e.message : String(e));
}

function load(at:int):int {
  return li32(at);
}

function store(at:uint, value:int):void {
  si16(value, at);
}

function caller(at:int):String {
  try {
    return String(load(at));
  } catch (e:RangeError) {
    return "caller " + describe(e);
  }
  return "";
}

trace(caller(1020), caller(1021), caller(-4));

try {
  store(0xfffffffe, 1);
} catch (e:*) {
  trace("store", describe(e));
}

// Through Array.forEach, a native calling back.
var addresses:Array = [0, 512, 2048];
try {
  addresses.forEach(function(at:int, i:int, a:Array):void {
    trace("each", at, li8(at));
  });
} catch (e:Error) {
  trace("forEach", describe(e));
}

// Past a finally in the method itself, then a catch of another type first.
function withFinally(at:int):int {
  var sum:int = 0;
  try {
    sum = li32(0);
    sum += li32(at);
  } finally {
    trace("finally", sum);
  }
  return sum;
}

try {
  withFinally(1022);
} catch (e:TypeError) {
  trace("TypeError?", describe(e));
} catch (e:RangeError) {
  trace("RangeError", describe(e));
}

// Caught where it happens, and the method goes on.
function goesOn():String {
  var out:Array = [];
  for (var at:int = 1016; at <= 1024; at += 4) {
    try {
      si32(at, at);
      out.push(li32(at));
    } catch (e:Error) {
      out.push(e.errorID);
    }
  }
  return out.join(" ");
}
trace(goesOn());

// In the script's own code.
var at:int = 4096;
try {
  sf64(1.5, at);
} catch (e:Error) {
  trace("script", describe(e));
}

// Another error from a method that also loads in place is as it was.
function nullAndMemory(o:Object, at:int):int {
  var v:int = li8(at);
  return o.length + v;
}
try {
  nullAndMemory(null, 0);
} catch (e:Error) {
  trace("null", describe(e));
}
