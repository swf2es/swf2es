// ByteArray edges: positions out of range, fractional and huge; lengths
// shrunk and grown; readBytes and writeBytes with offsets and lengths at
// their limits, and copies within one ByteArray in both directions.
import flash.utils.ByteArray;
import avmplus.getQualifiedClassName;
function hex(b:ByteArray):String {
  var s:String = "";
  for (var i:uint = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID, getQualifiedClassName(e)); }
}
function seq(n:uint):ByteArray {
  var b:ByteArray = new ByteArray();
  for (var i:uint = 0; i < n; i++) b.writeByte(i + 1);
  return b;
}

// Positions.
var p:ByteArray = seq(4);
var values:Array = [-1, -0.5, 0.5, 1.9, 2147483647, 2147483648, 2147483649.7, 4294967295,
  4294967296, 4294967297, 8589934593, NaN, Infinity, -Infinity, -4294967295, "3", null, undefined];
for each (var v:* in values) {
  p.position = v;
  trace("position", v, p.position, p.bytesAvailable);
}
p.position = 4294967295;
probe("byte at 2^32-1", function():* { p.writeByte(1); return p.length; });
probe("int at 2^32-1", function():* { p.writeInt(1); return p.length; });
probe("bytes at 2^32-1", function():* { p.writeBytes(seq(2)); return p.length; });
probe("utf at 2^32-1", function():* { p.writeUTFBytes("ab"); return p.length; });
probe("read at 2^32-1", function():* { return p.readByte(); });
trace(p.length, p.position);
p.position = 4294967294;
probe("bytes at 2^32-2", function():* { p.writeBytes(seq(2)); return p.length; });
trace(p.length, p.position);
p.position = 3.7;
trace(p.readByte(), p.position);

// Lengths.
var l:ByteArray = seq(8);
l.position = 6;
l.length = 3;
trace(hex(l), l.position, l.bytesAvailable);
l.length = 6;
trace(hex(l), l.position);
l.position = 100;
l.length = 10;
trace(hex(l), l.position, l.bytesAvailable);
l.length = 2.9;
trace(hex(l), l.length, l.position);
l.length = -0.5;
trace(l.length, l.position);
probe("length -1", function():* { l.length = -1; return l.length; });
probe("length 2^31", function():* { l.length = 2147483648; return l.length; });
probe("length 2^32-1", function():* { l.length = 4294967295; return l.length; });
trace(l.length, l.position);

// readBytes.
var r:ByteArray = seq(6);
var t:ByteArray;
r.position = 2;
t = seq(3);
r.readBytes(t);
trace("all", hex(t), r.position);
r.position = 1;
t = seq(3);
r.readBytes(t, 5, 0);
trace("offset beyond", hex(t), t.length, r.position);
r.position = 1;
t = seq(3);
r.readBytes(t, 0, 2);
trace("shorter", hex(t), t.length, r.position);
r.position = 6;
t = seq(3);
r.readBytes(t, 1);
trace("none left", hex(t), t.length, r.position);
r.position = 6;
t = seq(3);
r.readBytes(t, 3);
trace("none left at end", hex(t), t.length, r.position);
r.position = 10;
t = seq(3);
r.readBytes(t, 1);
trace("past end", hex(t), t.length, r.position);
r.position = 4;
probe("too many", function():* { r.readBytes(seq(1), 0, 3); });
trace(r.position);
probe("offset+count overflow", function():* { r.position = 0; r.readBytes(seq(1), 4294967295, 2); });
trace(r.position);
probe("offset huge", function():* { r.position = 0; r.readBytes(seq(1), 4026531840, 1); });
trace(r.position);
probe("offset -1", function():* { r.position = 0; r.readBytes(seq(1), -1, 1); });
trace(r.position);
probe("null target", function():* { r.position = 0; r.readBytes(null); });
trace(r.position);

// readBytes into itself.
var s:ByteArray = seq(8);
s.position = 0;
s.readBytes(s, 2, 4);
trace("self forward", hex(s), s.length, s.position);
s = seq(8);
s.position = 3;
s.readBytes(s, 1, 4);
trace("self backward", hex(s), s.length, s.position);
s = seq(8);
s.position = 2;
s.readBytes(s, 6);
trace("self grow", hex(s), s.length, s.position);
s = seq(8);
s.position = 2;
s.readBytes(s, 2);
trace("self same", hex(s), s.length, s.position);
s = seq(40);
s.position = 0;
s.readBytes(s, 4, 36);
trace("self long forward", hex(s), s.length, s.position);
s = seq(40);
s.position = 4;
s.readBytes(s, 0, 36);
trace("self long backward", hex(s), s.length, s.position);
s = seq(40);
s.position = 0;
s.readBytes(s, 4090, 40);
trace("self long grow", s.length, s[4090], s[4129], s.position);
s = seq(3000);
s.position = 0;
s.readBytes(s, 2000);
trace("self realloc", s.length, s[2000], s[2999], s[4999], s.position);

// writeBytes.
var w:ByteArray;
var src:ByteArray = seq(6);
probe("from 2", function():* { var w:ByteArray = new ByteArray(); w.writeBytes(src, 2); return hex(w) + " " + w.position; });
probe("from end", function():* { var w:ByteArray = new ByteArray(); w.writeBytes(src, 6); return hex(w) + " " + w.position; });
probe("from past end", function():* { var w:ByteArray = new ByteArray(); w.writeBytes(src, 9); return hex(w) + " " + w.position; });
probe("from past end 1", function():* { var w:ByteArray = new ByteArray(); w.writeBytes(src, 9, 1); return hex(w) + " " + w.position; });
probe("from 2^32-1", function():* { var w:ByteArray = new ByteArray(); w.writeBytes(src, 4294967295); return hex(w) + " " + w.position; });
probe("from -1", function():* { var w:ByteArray = new ByteArray(); w.writeBytes(src, -1); return hex(w) + " " + w.position; });
probe("to end", function():* { var w:ByteArray = new ByteArray(); w.writeBytes(src, 1, 5); return hex(w) + " " + w.position; });
probe("one past", function():* { new ByteArray().writeBytes(src, 1, 6); });
probe("count -1", function():* { new ByteArray().writeBytes(src, 0, -1); });
probe("empty", function():* { var w:ByteArray = new ByteArray(); w.writeBytes(new ByteArray()); return hex(w) + " " + w.position; });
w = seq(4); w.position = 2; w.writeBytes(src, 0, 1); trace("inside", hex(w), w.position);
w = seq(4); w.position = 9; w.writeBytes(src, 0, 2); trace("past end", hex(w), w.position);

// writeBytes from itself.
w = seq(8); w.position = 2; w.writeBytes(w, 0, 4); trace("self forward", hex(w), w.position);
w = seq(8); w.position = 0; w.writeBytes(w, 3, 4); trace("self backward", hex(w), w.position);
w = seq(8); w.position = 6; w.writeBytes(w); trace("self grow", hex(w), w.position);
w = seq(8); w.position = 8; w.writeBytes(w); trace("self append", hex(w), w.position);
w = seq(8); w.position = 3; w.writeBytes(w, 3, 2); trace("self same", hex(w), w.position);
w = seq(40); w.position = 4; w.writeBytes(w, 0, 36); trace("self long forward", hex(w), w.position);
w = seq(40); w.position = 0; w.writeBytes(w, 4, 36); trace("self long backward", hex(w), w.position);
w = seq(3000); w.position = 2000; w.writeBytes(w);
trace("self realloc", w.length, w[2000], w[4999], w[2999], w.position);
