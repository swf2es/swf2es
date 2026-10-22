package {
  import flash.display.Sprite;
  import flash.net.registerClassAlias;
  import flash.utils.ByteArray;
  import flash.utils.IDataInput;
  import flash.utils.IDataOutput;
  import flash.utils.IExternalizable;

  public class ByteArrayMultibyte extends Sprite {
    public function ByteArrayMultibyte() {
      probe("asset", [99,109,110,95,117,112,110,95,48,54,95,48,51,0,0], "shift_jis");
      probe("japanese", [0x82,0xa0,0x82,0xa2,0x82,0xa4], "shift-jis");
      probe("case", [0x82,0xa0], "SHIFT_JIS");
      probe("sjis invalid", [0x82,0x20,0x82], "shift_jis");
      probe("sjis private", [0xff,0x80,0xa0,0xfd], "shift_jis");
      probe("sjis nul", [0x82,0,97], "shift_jis");
      probe("chinese", [0xd6,0xd0,0xce,0xc4], "cn-gb");
      probe("big5", [0xa4,0xa4,0xa4,0xe5], "big5");
      probe("korean", [0xb0,0xa1], "ks_c_5601-1987");
      probe("unsupported euc-kr", [0xb0,0xa1], "euc-kr");
      probe("utf8", [0xc3,0xa4], "utf-8");
      probe("utf8 bom", [0xef,0xbb,0xbf,97], "utf-8");
      probe("utf8 nul", [97,0,98], "utf-8");
      probe("utf8 invalid", [0xc3,0x28,0xff,0xe2,0x82], "utf-8");
      probe("utf8 alias", [0xc3,0xa4], "utf8");
      probe("latin1", [65,0x80,0x91,0xe9], "iso-8859-1");
      probe("latin1 alias", [0x80,0x91,0xe9], "latin1");
      probe("windows", [65,0x80,0x91,0xe9], "windows-1252");
      probe("ascii", [65,0x80,66], "us-ascii");
      probe("unknown", [65,0x80,0x91,0xe9], "not-an-encoding");
      probe("empty label", [65,0x80,0x91,0xe9], "");
      probe("untrimmed", [0x82,0xa0], " Shift_JIS ");
      probe("utf16", [97,0,98,0], "utf-16");
      probe("utf16be", [0,97,0,98], "utf-16be");
      probe("unicode", [97,0,98,0], "unicode");
      probe("unicodefffe", [0,97,0,98], "unicodeFFFE");
      probe("utf16 bom", [0xff,0xfe,97,0], "utf-16");
      probe("utf16 swapped", [0xfe,0xff,0,97], "utf-16");
      probe("utf16 nul", [97,0,0,0,98,0], "utf-16");
      probe("utf16 surrogate", [97,0,0,0xd8,98], "utf-16");
      probe("utf16 odd", [97,0,98], "utf-16");
      probe("utf16 single", [97], "utf-16");
      probe("utf16 endian", [97,0,98,0], "utf-16", -1, 0, true);
      probe("offset", [0xff,0x82,0xa0,0xff], "shift_jis", 2, 1);
      probe("empty", [], "shift_jis");
      probe("zero at end", [97], "shift_jis", 0, 1);
      probe("zero past end", [97], "shift_jis", 0, 4);
      probe("eof", [97], "shift_jis", 2);
      probe("utf16 eof", [97], "utf-16", 2);
      probe("null", [97], null);
      probe("null eof", [], null, 1);

      registerClassAlias("multibyte.Payload", Payload);
      var b:ByteArray = new ByteArray();
      b.writeObject(new Payload());
      b.position = 0;
      trace("external", (b.readObject() as Payload).text, b.bytesAvailable);
    }

    private function probe(name:String, bytes:Array, charset:String, count:int = -1,
                           position:uint = 0, little:Boolean = false):void {
      var b:ByteArray = new ByteArray();
      for each (var value:int in bytes) {
        b.writeByte(value);
      }

      b.position = position;
      b.endian = little ? "littleEndian" : "bigEndian";
      try {
        var text:String = b.readMultiByte(count < 0 ? bytes.length : count, charset);
        var codes:Array = [];
        for (var i:int = 0; i < text.length; i++) {
          codes.push(text.charCodeAt(i));
        }

        trace(name, text.length, b.position, codes.join(","));
      } catch (error:Error) {
        trace(name, "error", error.errorID, b.position);
      }
    }
  }

  class Payload implements IExternalizable {
    public var text:String;

    public function writeExternal(output:IDataOutput):void {
      output.writeByte(0x82);
      output.writeByte(0xa0);
      output.writeByte(0);
    }

    public function readExternal(input:IDataInput):void {
      text = input.readMultiByte(3, "shift_jis");
    }
  }
}
