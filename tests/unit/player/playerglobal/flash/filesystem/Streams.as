package {
  import flash.display.Sprite;
  import flash.events.*;
  import flash.filesystem.*;
  import flash.utils.ByteArray;
  import flash.utils.getQualifiedClassName;

  public class Streams extends Sprite {
    private function t(label:String, f:Function):void {
      try {
        trace(label + ": " + f());
      } catch (e:Error) {
        // By its class, as adl's probe named it: flash.errors' classes are all named "Error".
        trace(label + ": THROWS " + getQualifiedClassName(e).replace(/^.*::/, "") + " " + e.errorID);
      }
    }

    public function Streams() {
      var data:File = File.applicationDirectory.resolvePath("data.bin");
      var fs:FileStream = new FileStream();
      t("fresh", function ():* { return fs.bytesAvailable; });
      t("fresh position", function ():* { return fs.position; });
      t("fresh settings", function ():* { return fs.endian + " " + fs.objectEncoding + " " + fs.readAhead; });
      t("fresh read", function ():* { return fs.readByte(); });
      fs.open(data, FileMode.READ);
      t("open", function ():* { return fs.bytesAvailable + " " + fs.position; });
      t("utf", function ():* { return fs.readUTFBytes(5) + " " + fs.position + " " + fs.bytesAvailable; });
      t("int", function ():* { return fs.readInt(); });
      t("endian", function ():* { fs.endian = "littleEndian"; fs.position = 5; return fs.readInt() + " " + fs.position; });
      t("bytes", function ():* { var b:ByteArray = new ByteArray(); fs.readBytes(b, 2, 3); return b.length + " " + b[2] + "," + b[4] + " " + fs.position; });
      t("bytes rest", function ():* { var b:ByteArray = new ByteArray(); fs.readBytes(b); return b.length + " " + fs.bytesAvailable; });
      t("eof", function ():* { return fs.readByte(); });
      t("past", function ():* { fs.position = 100; return fs.bytesAvailable + " " + fs.position; });
      t("past read", function ():* { return fs.readByte(); });
      t("write in read", function ():* { fs.writeByte(1); return "wrote"; });
      t("truncate in read", function ():* { fs.truncate(); return "truncated"; });
      fs.close();
      t("closed", function ():* { return fs.bytesAvailable; });
      t("closed read", function ():* { return fs.readByte(); });
      t("close twice", function ():* { fs.close(); return "ok"; });
      t("reopen", function ():* { fs.open(data, FileMode.READ); var r:String = fs.readUTFBytes(5); fs.close(); return r; });
      t("missing", function ():* { fs.open(File.applicationDirectory.resolvePath("missing.bin"), FileMode.READ); return "opened"; });
      t("directory", function ():* { fs.open(File.applicationDirectory.resolvePath("sub"), FileMode.READ); return "opened"; });
      t("no path", function ():* { fs.open(new File(), FileMode.READ); return "opened"; });
      t("bad mode", function ():* { fs.open(data, "nonsense"); return "opened"; });
      t("null file", function ():* { fs.open(null, FileMode.READ); return "opened"; });
      t("open while open", function ():* { fs.open(data, FileMode.READ); fs.open(data, FileMode.READ); var r:String = fs.position + " " + fs.bytesAvailable; fs.close(); return r; });

      var a:FileStream = new FileStream();
      for each (var type:String in [Event.OPEN, ProgressEvent.PROGRESS, Event.COMPLETE, Event.CLOSE, IOErrorEvent.IO_ERROR]) {
        a.addEventListener(type, function (e:Event):void {
          var extra:String = e is ProgressEvent ? " " + ProgressEvent(e).bytesLoaded + "/" + ProgressEvent(e).bytesTotal + " avail " + a.bytesAvailable : "";
          trace("async: " + e.type + extra);
          if (e.type == Event.COMPLETE) {
            trace("async: read " + a.readUTFBytes(5));
            a.close();
          }
        });
      }
      a.openAsync(data, FileMode.READ);
      trace("async: after openAsync avail " + a.bytesAvailable);
      t("async read before complete", function ():* { return a.readByte(); });

      var m:FileStream = new FileStream();
      m.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void { trace("missing async: ioError " + e.errorID + " " + e.text.indexOf("Error #3003: File or directory does not exist. file: ")); });
      m.openAsync(File.applicationDirectory.resolvePath("missing.bin"), FileMode.READ);

      var closed:FileStream = new FileStream();
      closed.addEventListener(Event.CLOSE, function (e:Event):void { trace("closed early: close event"); });
      closed.addEventListener(Event.COMPLETE, function (e:Event):void { trace("closed early: complete"); });
      closed.openAsync(data, FileMode.READ);
      closed.close();

      var sync:FileStream = new FileStream();
      sync.addEventListener(Event.CLOSE, function (e:Event):void { trace("sync: close event"); });
      sync.open(data, FileMode.READ);
      sync.close();

      var b:FileStream = new FileStream();
      var progress:int = 0;
      b.addEventListener(ProgressEvent.PROGRESS, function (e:ProgressEvent):void {
        progress++;
        if (progress == 1) { trace("big: first progress " + e.bytesLoaded + "/" + e.bytesTotal + " avail " + b.bytesAvailable); }
      });
      b.addEventListener(Event.COMPLETE, function (e:Event):void { trace("big: complete avail " + b.bytesAvailable + " after more than one progress " + (progress > 1)); b.close(); });
      b.openAsync(File.applicationDirectory.resolvePath("big.bin"), FileMode.READ);
    }
  }
}
