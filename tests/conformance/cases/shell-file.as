// avmshell's File: what it writes it reads back, as text or bytes, and the
// files it cannot open. /tmp is the oracle's container's own.
import avmplus.File;
import flash.utils.ByteArray;
const DIR:String = "/tmp/";
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e); }
}
function file(bytes:Array):ByteArray {
  var b:ByteArray = new ByteArray();
  for each (var x:int in bytes) {
    b.writeByte(x);
  }
  return b;
}
trace(File.exists(DIR + "shell-file-missing.txt"));
File.write(DIR + "shell-file-text.txt", "h\u00e9llo \u4e00");
trace(File.exists(DIR + "shell-file-text.txt"), escape(File.read(DIR + "shell-file-text.txt")));
var b:ByteArray = File.readByteArray(DIR + "shell-file-text.txt");
trace(b.length, b.position, b[1], b[2]);
// A byte order mark: UTF-8's is dropped, UTF-16's tells the order (not
// big-endian, which the oracle's avmshell misreads); a bad UTF-8 sequence
// is its bytes' characters.
var texts:Array = [
  [0xEF, 0xBB, 0xBF, 0x41, 0x42],
  [0xFF, 0xFE, 0x41, 0x00, 0x00, 0x4E],
  [0xE4, 0xB8, 0x80, 0xE4, 0xE4, 0xB8, 0x80],
];
for (var i:int = 0; i < texts.length; i++) {
  var name:String = DIR + "shell-file-" + i + ".bin";
  trace(File.writeByteArray(name, file(texts[i])), escape(File.read(name)));
}
probe("read missing", function():* { return File.read(DIR + "shell-file-missing.txt"); });
probe("bytes missing", function():* { return File.readByteArray(DIR + "shell-file-missing.txt"); });
probe("null name", function():* { return File.read(null); });
probe("null data", function():* { File.write(DIR + "shell-file-null.txt", null); });
probe("exists null", function():* { return File.exists(null); });
