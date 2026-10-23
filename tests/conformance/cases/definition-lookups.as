// What a name of a class finds, again and again, as a static's reads and
// calls do: the script defining it run first only when asked, its class
// read while that script runs, a child domain's own class, and a name the
// parent comes to define after the child first looked for it.
import avmplus.Domain;
import flash.utils.ByteArray;
// Two scripts: package two's class S, whose statics read S in a loop and
// one of whose initializers reads S while S's script runs, and whose script
// reads class E before E's script has run; then the entry, which defines E
// and uses S.
const TWO:String =
  "10002e00020000001a0563616c6c730003696e74056561726c7906537472696e670570726f626504" +
  "6e6578740373756d01530374776f064f626a6563740178054527732078016601450165076572726f" +
  "724944054572726f72016e062063616c6c730574726163651274776f2773206c6962726172792072" +
  "756e730c6c69627261727920736565731146696c65507269766174654e533a74776f1274776f2773" +
  "20656e74727920737461727473051602160a170a0518001207010107010307010407010507010607" +
  "010707010807020907010b07010c07010e07020f0703100701110701120701150704100900000000" +
  "0004060000020700010202088013000000000000000000040e000000000000000000000208090100" +
  "05000c09010008000405010000020103030000040005010001060100020701000307020a0000040d" +
  "010b010006010002080400000c04000109010305000227d030d0660170d6d24810170000d0305a00" +
  "2a63042a302b6d01600d660e70d71d0804d3482c02480102090d0f0d0002030200010dd030d02a66" +
  "01912ad56101d1480000030204000124d0302400d7240073d6240073d7100b000009d2d0460600a0" +
  "73d6c203d3d115efffffd248000004020100010cd030d04605005e032b6103470000050101000106" +
  "d030d0490047000006020100010ad030600866012c14a04800000700010000014700000801010001" +
  "06d030d0490047000000060300038701d030650060092a3058001d6808650060092a3058011d680c" +
  "6010642c164101296010642c17600c660a600c460b0041032910160000d0305a002ad62a302b6d01" +
  "6010642c1760114102291d6010642c194101296010642c04600866034102296010642c0860082405" +
  "460701600824054607014103296010642c0160086601600c460b0041032947012031350f1100";
// package q's class T, whose who() returns "parent".
const PARENT:String =
  "10002e000000000a0377686f0001540171064f626a65637406706172656e7406537472696e670574" +
  "7261636511706172656e7427732054206c6f61646564031602160400060701010702030701050701" +
  "07070108040000000000040100000000000000000000010203010003000201010100010100010204" +
  "000004010101000105d0302c06480000020001000001470000030101000106d030d0490047000000" +
  "0301000216d030650060032a3058001d68026005642c09410129470000";
// package q's class T again, whose who() returns "child", and class U,
// whose run(n) calls T.who() n times and later() once.
const CHILD:String =
  "10002e00000000100377686f0001540171064f626a6563740372756e056c61746572015505636869" +
  "6c6406537472696e67012003696e74016e0574726163650c6368696c64206c6f6164656403160216" +
  "04000a07010107020307010507010607010707020807010a07010c07010e08000000000007010000" +
  "0000000000000001070806800d000707000000000000000000000202030100030006030100070002" +
  "010101000106020401000405010005010002020400000604000108010101000105d0302c09480000" +
  "020001000001470000030101000106d030d04900470000040304000128d0302400d72c0285d62400" +
  "73d7100f000009d260024601002c0ba0a085d6c203d3d115ebffffd2480000050101000108d03060" +
  "02460100480000060001000001470000070101000106d030d04900470000000301000221d0306500" +
  "60032a3058001d6802650060032a3058011d68066009642c0f410129470000";
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
// The entry runs first; S's script only when the entry first reads S.
probe("two", function():* { return new Domain(Domain.currentDomain).loadBytes(bytes(TWO)); });
probe("two again", function():* { return new Domain(Domain.currentDomain).loadBytes(bytes(TWO)); });
// A child's own T, while its parent defines none.
var child:Domain = new Domain(Domain.currentDomain);
probe("child", function():* { return child.loadBytes(bytes(CHILD)); });
var U:Class = child.getClass("q.U");
probe("child's run", function():* { return U.run(3); });
// Then the parent defines T: what run, already run, and later, not yet
// run, find; and a new child, which finds the parent's.
probe("parent", function():* { return Domain.currentDomain.loadBytes(bytes(PARENT)); });
probe("child's run after", function():* { return U.run(3); });
probe("child's later after", function():* { return U.later(); });
probe("child's T after", function():* { return child.getClass("q.T").who(); });
var second:Domain = new Domain(Domain.currentDomain);
probe("second", function():* { return second.loadBytes(bytes(CHILD)); });
var U2:Class = second.getClass("q.U");
probe("second's run", function():* { return U2.run(3); });
probe("second's later", function():* { return U2.later(); });
probe("second's U is its own", function():* { return U2 !== U; });
// A grandchild, which defines nothing, finds through its parent.
var grandchild:Domain = new Domain(child);
probe("grandchild's T", function():* { return grandchild.getClass("q.T").who(); });
