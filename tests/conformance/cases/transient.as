// [Transient] members, which AMF and JSON leave out: variables, constants,
// and accessors marked on either half, as avmplus finds their metadata. An
// override with metadata of its own hides the base's; one without has it.
// A replacer's list of names writes them all the same, and AMF leaves out
// constants whatever their metadata. The runner compiles cases with -md,
// so that ASC keeps metadata.
package {
  public class T {
    public var a:int = 1;
    [Transient] public var b:int = 2;
    [Transient] public const c:int = 3;
    public const d:int = 4;
    [Other] public var e:int = 5;
    public function get both():int { return 7; }
    public function set both(v:int):void {}
    [Transient] public function get tget():int { return 8; }
    public function set tget(v:int):void {}
    public function get tset():int { return 9; }
    [Transient] public function set tset(v:int):void {}
    [Transient] public function get ro():int { return 10; }
    public function get ro2():int { return 11; }
  }
  public dynamic class D extends T {
    [Transient] public var f:int = 12;
  }
  public class O extends T {
    override public function get tget():int { return 14; }
    [Other] override public function set tset(v:int):void {}
    [Transient] override public function get both():int { return 15; }
  }
}
import flash.utils.ByteArray;
import flash.net.registerClassAlias;
// The names JSON wrote, and their values, sorted: avmplus orders them by its hashtable.
function keys(s:String):String {
  var o:Object = JSON.parse(s);
  var k:Array = [];
  for (var n:String in o) k.push(n + "=" + o[n]);
  k.sort();
  return k.join(",");
}
// What AMF wrote, read back: its length, and the variables, set first, so
// that one it left out reads back as its default.
function back(v:*):String {
  v.a = 101;
  v.b = 102;
  v.e = 105;
  if (v is D) v.f = 112;
  var b:ByteArray = new ByteArray();
  b.writeObject(v);
  b.position = 0;
  var o:* = b.readObject();
  return [b.length, o.a, o.b, o.e, o is D ? o.f : "-", o is D ? o.dyn : "-"].join(" ");
}
var d:D = new D();
d.dyn = 13;
trace("json", keys(JSON.stringify(new T())));
trace("json D", keys(JSON.stringify(d)));
trace("json O", keys(JSON.stringify(new O())));
trace("replacer", keys(JSON.stringify(new T(), ["a", "b", "tget", "ro"])));
registerClassAlias("t.T", T);
registerClassAlias("t.D", D);
registerClassAlias("t.O", O);
trace("amf", back(new T()));
trace("amf D", back(d));
trace("amf O", back(new O()));
