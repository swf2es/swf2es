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
      for each (id in ["el-GR", "en-US"]) {
        st = new StringTools(id);
        trace(id, st.toUpperCase("\u03ac\u03bb\u03c6\u03b1 \u03ad\u03c8\u03b9\u03bb\u03bf\u03bd \u03ce\u03bc\u03b5\u03b3\u03b1 \u03ca \u0390 \u1fb3 \u1fbc \u01f0 \ufb00"),
          st.toLowerCase("\u0386\u039b\u03a6\u0391 \u039f\u0394\u039f\u03a3 \u03a3 \u1fbc"));
      }
      st = new StringTools("lt-LT");
      trace("lt", st.toLowerCase("\u00cc\u00cd\u0128\u012e\u00cf\u0130 I J"), st.toUpperCase("\u00ec\u00ed\u0129 i j"));
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
