// avmshell leaves multibyte decoding to the embedding player. Preserve its stub.
import flash.utils.ByteArray;
var bytes:ByteArray = new ByteArray();
bytes.writeByte(65);
bytes.writeByte(66);
bytes.position = 0;
for each (var charset:String in ["utf-8", "shift_jis", "windows-1252", "unknown"]) {
  trace(charset, bytes.readMultiByte(2, charset).length, bytes.position);
}
for each (var count:uint in [0, 2, 3]) {
  try {
    trace("read", count, bytes.readMultiByte(count, "utf-8").length, bytes.position);
  } catch (error:Error) {
    trace("read", count, error.errorID, bytes.position);
  }
}
try {
  bytes.readMultiByte(1, null);
} catch (nullError:Error) {
  trace("null", nullError.errorID, bytes.position);
}
