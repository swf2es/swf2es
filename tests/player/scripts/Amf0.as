// AMF0, as Flash's ByteArray writes and reads it for an objectEncoding
// below 3, and a SharedObject's .sol of it: the bytes of each kind of
// value, the table of references, what is read back, and what reading
// makes of markers and bytes it does not expect. A Date's zone is the
// host's, so it is compared, not printed; an object of several properties
// is printed by its names, whose order is Flash's hash's.
package {
  import flash.display.Sprite;
  import flash.net.SharedObject;
  import flash.net.registerClassAlias;
  import flash.utils.ByteArray;
  import flash.utils.Dictionary;
  import flash.utils.getQualifiedClassName;
  import flash.xml.XMLDocument;

  public class Amf0 extends Sprite {
    public function Amf0() {
      registerClassAlias("amf0.Typed", Typed);
      registerClassAlias("amf0.Ext", Ext);
      registerClassAlias("amf0.Accessors", Accessors);

      // Numbers are doubles, -0 kept; strings a u16 length, or a u32 past 0xffff bytes.
      w("int", 3);
      w("negative", -5);
      w("uint", uint(4000000000));
      w("negative zero", -0);
      w("half", 0.5);
      w("infinity", Number.NEGATIVE_INFINITY);
      w("true", true);
      w("false", false);
      w("null", null);
      w("undefined", undefined);
      w("string", "hé");
      w("empty string", "");
      var long:String = "";
      for (var i:int = 0; i < 70000; i++) {
        long += "a";
      }
      var b:ByteArray = bytes(long);
      trace("long string", b.length, hex(b).substr(0, 14));
      var longKey:Object = {};
      longKey[long] = true;
      b = bytes(longKey);
      trace("long key", b.length, hex(b).substr(0, 14));

      // Objects, and a table of references from 0 for each writeObject.
      var o:Object = {a: 1};
      var self:Object = {};
      self.me = self;
      w("object", o);
      w("self", self);
      w("twice", [o, o]);
      w("nested", {x: {y: [o, {z: o}]}});
      w("function", function():void {});
      w("function property", {f: function():void {}, g: 2});
      w("number key", {1: "one"});
      b = bytes(o);
      b.objectEncoding = 0;
      b.writeObject(o);
      trace("two writes", hex(b));

      // Arrays are ECMA arrays: their length, then the elements there are and the rest by name.
      w("dense", [1, 2]);
      var sparse:Array = [];
      sparse[2] = "x";
      w("sparse", sparse);
      w("functions", [1, function():void {}, 3]);
      w("undefined elements", [undefined, null]);
      w("empty array", []);
      var named:Array = ["m"];
      named.custom = "c";
      w("named", named);
      var longer:Array = [1];
      longer.length = 70000;
      w("longer", longer);

      // Dates, which take a place among the references, and their zone.
      var date:Date = new Date(1672531200000);
      b = bytes(date);
      trace("date", hex(b).substr(0, 18), zone(b, 9) == date.getTimezoneOffset());
      var summer:Date = new Date(2023, 6, 1);
      b = bytes(summer);
      trace("summer", zone(b, 9) == summer.getTimezoneOffset());
      // Its time a NaN, whose bits are free (the conformance case nan-bytes.as), its zone 0.
      b = bytes(new Date(NaN));
      b.position = 1;
      trace("invalid date", b.length, hex(b).substr(0, 2), isNaN(b.readDouble()), b.readShort());
      b = bytes([date, date]);
      trace("date twice", hex(b).substr(0, 34), hex(b).substr(38));

      // XML documents as their text; E4X as an empty object.
      var doc:XMLDocument = new XMLDocument("<a b='c'><d/></a>");
      w("xml document", doc);
      w("xml document twice", [doc, doc]);
      var x:XML = <a b="c"><d/></a>;
      w("xml", x);
      w("xml twice", [x, x]);
      w("xml list", new XMLList("<a/><b/>"));

      // Classes: typed by an alias, their public variables and read-write
      // accessors ([Transient] ones too) and then their dynamic properties.
      var t:Typed = new Typed();
      t.dyn = "d";
      w("typed", t);
      w("transient", new Transients());
      w("accessors", new Accessors());
      w("sealed", new Sealed());
      w("externalizable", new Ext());
      w("class", Statics);
      var d:Dictionary = new Dictionary();
      d["k"] = 1;
      w("dictionary", d);
      var objectKeys:Dictionary = new Dictionary();
      objectKeys[o] = 2;
      objectKeys[1] = "one";
      objectKeys[true] = "t";
      unordered("dictionary keys", objectKeys);
      var array:ByteArray = new ByteArray();
      array.writeByte(7);
      unordered("bytearray", array);
      var v:Vector.<String> = new Vector.<String>();
      v.push("a");
      v.fixed = true;
      unordered("vector", v);
      unordered("vector of int", new <int>[1, 2]);

      // Past 0xffff objects, a reference's place is cut to 16 bits.
      var many:Array = [];
      for (i = 0; i < 65540; i++) {
        many.push({});
      }
      many.push(many[65537]);
      b = bytes(many);
      trace("many", b.length, hex(b).substr(hex(b).length - 22));
      b.position = 0;
      var back:Array = b.readObject();
      trace("many back", back.length, back[65540] === back[65537], back[65540] === back[1]);

      // Reading.
      r("boolean 2", [1, 2]);
      r("amf3 marker", [0x11, 6, 7, 0x61, 0x62, 0x63]);
      r("amf3 in array", [0x0a, 0, 0, 0, 2, 0x11, 6, 7, 0x61, 0x62, 0x63, 0x11, 6, 0]);
      r("movieclip", [4]);
      r("unsupported", [0x0d]);
      r("recordset", [0x0e]);
      r("object end", [9]);
      r("marker 0x12", [0x12]);
      r("marker 0xff", [0xff]);
      r("end in number", [0, 0x3f]);
      r("nothing", []);
      r("end in string", [2, 0, 5, 0x61]);
      r("end in object", [3, 0, 1, 0x61, 0, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0]);
      r("reference past", [7, 0, 3]);
      r("self reference", [3, 0, 2, 0x6d, 0x65, 7, 0, 0, 0, 0, 9]);
      r("strict array", [0x0a, 0, 0, 0, 3, 0, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0, 6, 2, 0, 1, 0x61]);
      r("strict array reference", [0x0a, 0, 0, 0, 2, 3, 0, 0, 9, 7, 0, 1]);
      r("date reference", [0x0a, 0, 0, 0, 2, 0x0b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0, 1]);
      r("long string", [0x0c, 0, 0, 0, 2, 0x61, 0x62]);
      r("xml", [0x0f, 0, 0, 0, 4, 0x3c, 0x61, 0x2f, 0x3e]);
      r("xml reference", [0x0a, 0, 0, 0, 2, 0x0f, 0, 0, 0, 4, 0x3c, 0x61, 0x2f, 0x3e, 7, 0, 1]);
      r("date zone", [0x0b, 0x42, 0x78, 0x56, 0xaa, 0x0c, 0x80, 0, 0, 0x01, 0x2c]);
      r("ecma length", [8, 0, 0, 0, 5, 0, 1, 0x30, 1, 1, 0, 0, 9]);
      r("empty name", [3, 0, 0, 1, 1, 0, 1, 0x61, 1, 0, 0, 0, 9]);
      r("unknown alias", [0x10, 0, 3, 0x7a, 0x7a, 0x7a, 0, 1, 0x61, 1, 1, 0, 0, 9]);
      r("typed", [0x10, 0, 10, 0x61, 0x6d, 0x66, 0x30, 0x2e, 0x54, 0x79, 0x70, 0x65, 0x64,
        0, 1, 0x78, 0, 0x40, 0x14, 0, 0, 0, 0, 0, 0, 0, 2, 0x71, 0x71, 1, 1, 0, 0, 9]);
      r("externalizable", [0x10, 0, 8, 0x61, 0x6d, 0x66, 0x30, 0x2e, 0x45, 0x78, 0x74,
        0, 1, 0x76, 0, 0x40, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 9]);

      // An encoding below 3 is AMF0, any other AMF3; ObjectOutput is AMF3 whatever it is set to.
      ByteArray.defaultObjectEncoding = 1;
      trace("default 1", ByteArray.defaultObjectEncoding, new ByteArray().objectEncoding);
      b = new ByteArray();
      b.writeObject({a: 1});
      trace("encoding 1", hex(b));
      ByteArray.defaultObjectEncoding = 7;
      b = new ByteArray();
      b.writeObject({a: 1});
      trace("encoding 7", hex(b));
      ByteArray.defaultObjectEncoding = 3;
      try {
        new ByteArray().objectEncoding = 2;
      } catch (e:Error) {
        trace("encoding 2", e.errorID);
      }
      b = new ByteArray();
      b.writeObject(new Ext());
      trace("writeExternal", hex(b));
      b.position = 0;
      trace("readExternal", b.readObject().v);

      // SharedObjects of AMF0: their sizes, an object written twice a reference.
      SharedObject.defaultObjectEncoding = 0;
      var so:SharedObject = SharedObject.getLocal("amf0Case");
      so.clear();
      trace("so encoding", so.objectEncoding);
      var shared:Object = {k: 1};
      so.data.n = 1.5;
      so.data.s = "str";
      so.data.o = shared;
      so.data.p = shared;
      so.data.a = [1, "x"];
      so.data.d = new Date(0);
      so.data.u = undefined;
      so.data.nul = null;
      trace("so size", so.size);
      trace("so flush", so.flush(), so.size);
      SharedObject.defaultObjectEncoding = 3;
      var so3:SharedObject = SharedObject.getLocal("amf3Case");
      so3.clear();
      so3.data.o = shared;
      so3.data.p = shared;
      so3.data.s = "str";
      so3.data.t = "str";
      trace("so3 size", so3.size);
      SharedObject.defaultObjectEncoding = 7;
      trace("so default", SharedObject.defaultObjectEncoding);
      SharedObject.defaultObjectEncoding = 3;
      so.clear();
      so3.clear();
    }

    private static function bytes(v:*):ByteArray {
      var b:ByteArray = new ByteArray();
      b.objectEncoding = 0;
      b.writeObject(v);
      return b;
    }

    /** The s16 zone of a Date written at `at`. */
    private static function zone(b:ByteArray, at:int):int {
      b.position = at;
      return b.readShort();
    }

    private function w(label:String, v:*):void {
      var b:ByteArray = new ByteArray();
      b.objectEncoding = 0;
      b.writeObject(v);
      trace(label, hex(b));
      b.position = 0;
      var back:* = b.readObject();
      trace("  back", describe(back), b.position == b.length);
    }

    /** An object of several properties, which Flash writes in its hash's order: its length, and what it reads back as. */
    private function unordered(label:String, v:*):void {
      var b:ByteArray = bytes(v);
      b.position = 0;
      trace(label, b.length, describe(b.readObject()), b.position == b.length);
    }

    private function r(label:String, bytes:Array):void {
      var b:ByteArray = new ByteArray();
      b.objectEncoding = 0;
      for each (var x:int in bytes) {
        b.writeByte(x);
      }
      b.position = 0;
      try {
        var v:* = b.readObject();
        trace(label, describe(v), b.position);
      } catch (e:Error) {
        trace(label, getQualifiedClassName(e), e.errorID, b.position);
      }
    }

    private function describe(v:*):String {
      if (v === null || v === undefined) {
        return String(v);
      }
      var s:String = getQualifiedClassName(v);
      if (v is Number || v is String || v is Boolean || v is XMLDocument) {
        return s + " " + v;
      }
      if (v is Date) {
        return s + " " + v.time;
      }
      if (v is Array) {
        s += " length " + v.length;
      }
      if (v is Typed) {
        s += " x " + v.x;
      }
      if (v is Ext) {
        s += " v " + v.v;
      }
      var keys:Array = [];
      for (var k:String in v) {
        var value:* = v[k];
        var shown:String;
        if (value === v) {
          shown = "self";
        } else if (value is Object && !(value is Number || value is String || value is Boolean)) {
          shown = getQualifiedClassName(value);
        } else {
          shown = String(value);
        }
        keys.push(k + "=" + shown);
      }
      keys.sort();
      return s + " {" + keys.join(" ") + "}";
    }

    private static function hex(b:ByteArray):String {
      var s:String = "";
      for (var i:int = 0; i < b.length; i++) {
        var h:String = b[i].toString(16);
        s += (h.length < 2 ? "0" : "") + h;
      }
      return s;
    }
  }
}

import flash.utils.IDataInput;
import flash.utils.IDataOutput;
import flash.utils.IExternalizable;

dynamic class Typed {
  public var x:int = 3;
  public const c:int = 4;
  private var p:int = 5;
}

class Transients {
  [Transient] public var tr:int = 9;
}

class Accessors {
  private var _acc:int = 6;

  public function get acc():int {
    return _acc;
  }

  public function set acc(v:int):void {
    _acc = v;
  }

  public function get ro():int {
    return 7;
  }
}

class Sealed {
  public var y:Number = 1.5;
}

class Statics {
  public static var sv:int = 1;
  public var iv:int = 2;
}

class Ext implements IExternalizable {
  public var v:int = 11;

  public function writeExternal(output:IDataOutput):void {
    output.writeInt(v);
    output.objectEncoding = 0;
    output.writeObject({q: [1, 2]});
  }

  public function readExternal(input:IDataInput):void {
    v = input.readInt();
    input.objectEncoding = 0;
    trace("  readExternal", input.readObject().q);
  }
}
