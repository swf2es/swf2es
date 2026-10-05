package {
  import flash.display.Sprite;
  import flash.text.engine.TabStop;

  public class TabStopNatives extends Sprite {
    public function TabStopNatives() {
      var tab:TabStop = new TabStop();
      trace("defaults", tab.alignment, tab.position, "[" + tab.decimalAlignmentToken + "]");
      tab.alignment = "center";
      tab.position = 12.5;
      tab.decimalAlignmentToken = ".";
      trace("changed", tab.alignment, tab.position, tab.decimalAlignmentToken);

      try { tab.alignment = null; trace("null alignment accepted"); }
      catch (e:Error) { trace("null alignment", e.toString()); }
      try { tab.alignment = "Center"; trace("bad alignment accepted"); }
      catch (e:Error) { trace("bad alignment", e.toString()); }
      trace("alignment after errors", tab.alignment);

      try { tab.position = -1; trace("negative accepted"); }
      catch (e:Error) { trace("negative", e.toString()); }
      tab.position = NaN;
      trace("nan", tab.position);
      tab.position = Infinity;
      trace("infinity", tab.position);
      try { tab.position = -Infinity; trace("negative infinity accepted"); }
      catch (e:Error) { trace("negative infinity", e.toString()); }
      trace("position after error", tab.position);

      try { tab.decimalAlignmentToken = null; trace("null token accepted"); }
      catch (e:Error) { trace("null token", e.toString()); }
      tab.decimalAlignmentToken = "abc";
      trace("token", tab.decimalAlignmentToken);

      try { new TabStop("invalid", -1, null); trace("bad constructor accepted"); }
      catch (e:Error) { trace("bad constructor", e.toString()); }
    }
  }
}
