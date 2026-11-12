// readUTFBytes and readUTF of short strings, as a C program's names are read
// from its memory: ASCII, a NUL ending the string inside the bytes read, bytes
// past ASCII, a BOM, none at all, and the position after each.
import flash.utils.ByteArray;

function show(label:String, s:String, b:ByteArray):void {
  var codes:Array = [];
  for (var i:int = 0; i < s.length; i++) {
    codes.push(s.charCodeAt(i));
  }
  trace(label, s.length, codes.join(","), "at", b.position);
}

function bytes(...values):ByteArray {
  var b:ByteArray = new ByteArray();
  for each (var v:int in values) {
    b.writeByte(v);
  }
  b.position = 0;
  return b;
}

var b:ByteArray = bytes(97);
show("one", b.readUTFBytes(1), b);
b = bytes(97, 98, 99, 100);
show("part", b.readUTFBytes(3), b);
show("rest", b.readUTFBytes(1), b);
b = bytes(97, 0, 98, 99);
show("nul inside", b.readUTFBytes(4), b);
b = bytes(0, 97, 98);
show("nul first", b.readUTFBytes(3), b);
b = bytes(97, 98, 0);
show("nul last", b.readUTFBytes(3), b);
b = bytes(97);
show("none", b.readUTFBytes(0), b);
b = bytes(97, 0xc3, 0xa4, 98);
show("past ascii", b.readUTFBytes(4), b);
b = bytes(0xc3, 0xa4, 0, 98);
show("past ascii then nul", b.readUTFBytes(4), b);
b = bytes(97, 0xff, 98);
show("invalid", b.readUTFBytes(3), b);
b = bytes(0xef, 0xbb, 0xbf, 97, 98);
show("bom", b.readUTFBytes(5), b);
b = bytes(97, 0xef, 0xbb, 0xbf, 98);
show("bom inside", b.readUTFBytes(5), b);
var twentyFour:ByteArray = new ByteArray();
twentyFour.writeUTFBytes("abcdefghijklmnopqrstuvwxyz");
twentyFour.position = 0;
show("24", twentyFour.readUTFBytes(24), twentyFour);
twentyFour.position = 0;
show("25", twentyFour.readUTFBytes(25), twentyFour);
b = bytes(0, 2, 104, 105, 33);
show("readUTF", b.readUTF(), b);
b = bytes(0, 3, 104, 0, 105);
show("readUTF nul", b.readUTF(), b);
b = bytes(97, 98);
try {
  b.readUTFBytes(3);
} catch (e:Error) {
  trace("past the end", e.errorID, b.position);
}
