// A pool string that is not well-formed UTF-8, as avmplus reads it: a byte
// that starts no sequence is the character of its value, a surrogate's
// three bytes are that code unit, and a sequence by its shape alone. Each
// ABC is a script tracing escape() of its one string, loaded with that
// string's 11 bytes in place of "PLACEHOLDER". (Not a 5-byte form, which
// the oracle's avmshell reads past the string's end.)
import avmplus.Domain;
import flash.utils.ByteArray;
const TEMPLATE:String =
  "10002e000000000505747261636500066573636170650b504c414345484f4c44455202160200030701010701030100000000000001000001000501000110d0306001646002642c044101410129470000";
const PLACEHOLDER:String = "504c414345484f4c444552";
function bytes(hex:String):ByteArray {
  var b:ByteArray = new ByteArray();
  for (var i:int = 0; i < hex.length; i += 2) {
    b.writeByte(parseInt(hex.substr(i, 2), 16));
  }
  return b;
}
for each (var s:String in [
  "61f09f9862eda08063c0af", // a, a cut 4-byte sequence, b, a surrogate, c, an overlong 2-byte form
  "e280a8e280a9225c0a7f41", // U+2028, U+2029, a quote, a backslash, a line feed, DEL
  "fffe41c3a9428081828384", // lone bytes, an é, lone continuation bytes
  "f4908080f5808080edbfbf", // past U+10FFFF, from F5, the last surrogate
  "c2e282f09f9880e0808041", // cut 2- and 3-byte sequences, an emoji, an overlong 3-byte form
]) {
  try {
    Domain.currentDomain.loadBytes(bytes(TEMPLATE.replace(PLACEHOLDER, s)));
  } catch (e:Error) {
    trace(s, e);
  }
}
