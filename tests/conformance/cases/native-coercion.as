// A native's String, Number, int, uint and Boolean parameters, where the
// verifier could not bind the call and so did not coerce its arguments:
// through an untyped receiver, a method closure, or an untyped setter.
// avmplus coerces them on entry however the native was called, an object
// by its toString or valueOf, an XMLList to its text, null to a String's
// null; the same calls bound and typed agree.
import flash.utils.ByteArray;

function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); }
}

var text:Object = { toString: function():String { return "hi"; } };
var seven:Object = { valueOf: function():Number { return 7; } };
var xml:XML = <a n="ok"/>;

var b:* = new ByteArray();
probe("String from object", function():* { b.writeUTFBytes(text); return b.length; });
probe("String from XMLList", function():* { b.writeUTFBytes(xml.@n); return b.length; });
probe("String from null", function():* { b.writeUTFBytes(null); return b.length; });
probe("int from object", function():* { b.position = 0; b.writeByte(seven); b.position = 0; return b.readByte(); });
probe("int from string", function():* { b.position = 0; b.writeByte("300"); b.position = 0; return b.readUnsignedByte(); });
probe("uint setter from string", function():* { b.position = "2"; return b.position; });
probe("uint setter from object", function():* { b.position = seven; return b.position; });
probe("Boolean from string", function():* { b.position = 0; b.writeBoolean("false"); b.position = 0; return b.readBoolean(); });
probe("Number from string", function():* { b.position = 0; b.writeDouble("2.5"); b.position = 0; return b.readDouble(); });
probe("closure", function():* { var f:Function = b.writeUTFBytes; f(text); return b.length; });

var m:* = Math;
probe("Math.pow", function():* { return m.pow("2", seven); });
probe("Math.atan2", function():* { return m.atan2(seven, "0"); });

var t:ByteArray = new ByteArray();
probe("typed", function():* { t.writeUTFBytes(text); t.writeByte(seven); return t.length; });
