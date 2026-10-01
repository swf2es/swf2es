// Function.length of a native method is its declared parameter count, as
// avmplus takes it from the ABC, however the native is written: one with
// optional parameters counts them, one with none counts none.
import flash.utils.ByteArray;

var b:ByteArray = new ByteArray();
trace("readBytes", b.readBytes.length);
trace("writeBytes", b.writeBytes.length);
trace("readByte", b.readByte.length);
trace("readUTFBytes", b.readUTFBytes.length);
trace("writeMultiByte", b.writeMultiByte.length);
trace("exec", /a/.exec.length);
trace("indexOf", "abc".indexOf.length);
trace("String", String.length);

function two(a:int, c:int = 1):void {}
trace("two", two.length);
