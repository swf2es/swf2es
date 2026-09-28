// A native error class called as a function makes an error, as
// ErrorClass::call constructs one; flash.errors' classes are AS3 classes,
// and a call of one coerces.
import flash.errors.IOError;

function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); }
}

probe("Error", function():* { return Error("x") + " " + (Error("x") is Error); });
probe("TypeError", function():* { var e:* = TypeError("t", 5); return e + " " + e.errorID + " " + (e is TypeError); });
probe("RangeError of none", function():* { return RangeError(); });
probe("ArgumentError", function():* { return ArgumentError("a").message; });
probe("IOError coerces", function():* { return IOError(new IOError("io")).message; });
probe("IOError of a string", function():* { return IOError("io"); });
