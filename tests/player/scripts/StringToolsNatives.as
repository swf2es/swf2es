package {
  import flash.display.Sprite;
  import flash.globalization.StringTools;

  public class StringToolsNatives extends Sprite {
    public function StringToolsNatives() {
      for each (var id:String in ["en-US", "tr-TR", "de-DE", "el-GR", "lt-LT", "fi-FI", "xx", ""]) {
        var st:StringTools = new StringTools(id);
        trace(id, "|", st.requestedLocaleIDName, st.actualLocaleIDName, st.lastOperationStatus);
        trace("  ", st.toUpperCase("istanbul ıi ß ﬁ ǆ ŉ äöå σας"), "|",
          st.toLowerCase("İSTANBUL Iİ ΣΑΣ ẞ Ǆ ÄÖÅ"), "|", "[" + st.toUpperCase("") + "]", st.lastOperationStatus);
      }
      st = new StringTools("xx");
      trace("status", st.lastOperationStatus, st.toLowerCase("A"), st.lastOperationStatus);
      call("upper null", function():void { st.toUpperCase(null); });
      call("lower null", function():void { st.toLowerCase(null); });
      call("constructor null", function():void { new StringTools(null); });
      trace("available", StringTools.getAvailableLocaleIDNames().length > 0);
    }

    private static function call(name:String, f:Function):void {
      try {
        f();
        trace(name, "ok");
      } catch (e:Error) {
        trace(name, e.toString());
      }
    }
  }
}
