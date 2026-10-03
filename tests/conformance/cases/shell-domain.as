// avmshell's Domain: an ABC loaded and run at once into a domain of its
// own, a class found by its name there, and what loadBytes and getClass
// refuse.
import avmplus.Domain;
import flash.utils.ByteArray;
// A small ABC: package loaded's class Loaded, and a script that traces.
const LOADED:String =
  "10002e000000000a08746f537472696e6700064c6f61646564066c6f61646564064f626a65637408" +
  "61204c6f6164656406537472696e670574726163650b6c6f616465642072756e7303160216040006" +
  "07010107020307010507010707010804000000000004010000000000000000000001020301000301" +
  "0101000102000100010204000004010101000105d0302c0648000002000100000147000003010100" +
  "0106d030d04900470000000301000216d030650060032a3058001d68026005642c09410129470000";
function bytes(hex:String):ByteArray {
  var b:ByteArray = new ByteArray();
  for (var i:int = 0; i < hex.length; i += 2) {
    b.writeByte(parseInt(hex.substr(i, 2), 16));
  }
  return b;
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e); }
}
var d:Domain = new Domain(Domain.currentDomain);
probe("load", function():* { return d.loadBytes(bytes(LOADED), 10); });
probe("child", function():* { return d.getClass("loaded.Loaded"); });
probe("child Object", function():* { return d.getClass("Object") === Object; });
// A child's definitions are its own: not its parent's, nor a sibling's,
// which defines them again; a grandchild sees its parent's.
var childClass:Class = d.getClass("loaded.Loaded");
probe("parent", function():* { return Domain.currentDomain.getClass("loaded.Loaded"); });
var sibling:Domain = new Domain(Domain.currentDomain);
probe("load sibling", function():* { return sibling.loadBytes(bytes(LOADED)); });
probe("sibling's own", function():* { return sibling.getClass("loaded.Loaded") !== childClass; });
var grandchild:Domain = new Domain(d);
probe("grandchild", function():* { return grandchild.getClass("loaded.Loaded") === childClass; });
var e:Domain = Domain.currentDomain;
probe("load current", function():* { return e.loadBytes(bytes(LOADED)); });
probe("current", function():* { return new (e.getClass("loaded.Loaded"))(); });
probe("current again", function():* { return new (Domain.currentDomain.getClass("loaded.Loaded"))(); });
probe("child after", function():* { return d.getClass("loaded.Loaded"); });
// Then the parent defines the name too: whose class the child finds now.
probe("child after is the parent's", function():* { return d.getClass("loaded.Loaded") === e.getClass("loaded.Loaded"); });
probe("child after is its own", function():* { return d.getClass("loaded.Loaded") === childClass; });
probe("missing class", function():* { return d.getClass("loaded.Missing"); });
probe("not a class", function():* { return d.getClass("trace"); });
probe("null name", function():* { return d.getClass(null); });
probe("null bytes", function():* { return d.loadBytes(null); });
probe("swf version", function():* { return d.loadBytes(bytes(LOADED), 8); });
probe("truncated", function():* { return d.loadBytes(bytes(LOADED.substr(0, 100))); });
probe("not an abc", function():* { return d.loadBytes(bytes("00112233")); });
