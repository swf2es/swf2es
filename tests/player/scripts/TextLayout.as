package {
  import flash.display.*;
  import flash.text.*;

  // Text laid out in an embedded font of rectangles (cases.ts's "Probe"):
  // advances, kerning, spacing, missing glyphs, newlines, word wrap, margins,
  // indents, alignment, mixed sizes and autoSize, as adl measures them.
  public class TextLayout extends Sprite {
    private function field(text:String, size:Number, extra:Object = null):TextField {
      var t:TextField = new TextField();
      t.embedFonts = true;
      var f:TextFormat = new TextFormat("Probe", size);
      if (extra) {
        for (var k:String in extra) {
          if (f.hasOwnProperty(k)) f[k] = extra[k];
        }
      }
      t.defaultTextFormat = f;
      if (extra && extra.width) t.width = extra.width;
      if (extra && extra.wordWrap) t.wordWrap = true;
      if (extra && extra.multiline) t.multiline = true;
      t.text = text;
      addChild(t);
      return t;
    }

    private function field2(text:String, f:TextFormat):TextField {
      var t:TextField = new TextField();
      t.embedFonts = true;
      t.defaultTextFormat = f;
      t.text = text;
      addChild(t);
      return t;
    }

    private function show(label:String, t:TextField):void {
      var parts:Array = [label, "w", t.textWidth, "h", t.textHeight, "lines", t.numLines];
      for (var i:int = 0; i < t.numLines; i++) {
        var m:TextLineMetrics = t.getLineMetrics(i);
        parts.push("| x", m.x, "w", m.width, "h", m.height, "a", m.ascent, "d", m.descent, "l", m.leading, "len", t.getLineLength(i), "off", t.getLineOffset(i));
      }
      trace(parts.join(" "));
      var b:Array = [];
      for (var c:int = 0; c < t.length; c++) {
        b.push(c + ":" + t.getCharBoundaries(c));
      }
      trace("  chars", b.join(" "));
    }

    public function TextLayout() {
      show("ab 20", field("ab", 20));
      show("ab 20 kern", field("ab", 20, {kerning: true}));
      show("ab 13", field("ab", 13));
      show("abc 10.5", field("abc", 10.5));
      show("trailing", field("ab  ", 20));
      show("empty", field("", 20));
      show("missing z", field("azb", 20));
      show("wrap", field("ab ab ab ab", 20, {width: 60, wordWrap: true}));
      show("wrap long word", field("abababababab", 20, {width: 60, wordWrap: true}));
      show("newlines", field("ab\rcab\r", 20, {multiline: true}));
      show("newlines single", field("ab\rcab", 20));
      show("leading", field("ab\rab", 20, {multiline: true, leading: 5}));
      show("letterSpacing", field("abc", 20, {letterSpacing: 2}));
      show("margins", field("ab", 20, {leftMargin: 5, rightMargin: 3, indent: 10}));
      show("center", field("ab", 20, {align: "center"}));
      show("right", field("ab", 20, {align: "right"}));
      var mixed:TextField = field("abab", 20);
      mixed.setTextFormat(new TextFormat(null, 40), 2, 3);
      show("mixed sizes", mixed);
      var auto:TextField = field("abW", 20);
      auto.autoSize = TextFieldAutoSize.LEFT;
      trace("autosize left", auto.x, auto.y, auto.width, auto.height);
      var autoC:TextField = field("abW", 20);
      autoC.autoSize = TextFieldAutoSize.CENTER;
      trace("autosize center", autoC.x, autoC.width, autoC.height);
      var autoR:TextField = field("abW", 20);
      autoR.autoSize = TextFieldAutoSize.RIGHT;
      trace("autosize right", autoR.x, autoR.width);
      var autoW:TextField = field("ab ab ab ab", 20, {width: 60, wordWrap: true});
      autoW.autoSize = TextFieldAutoSize.LEFT;
      trace("autosize wrap", autoW.width, autoW.height, autoW.numLines);
      var autoE:TextField = field("", 20);
      autoE.autoSize = TextFieldAutoSize.LEFT;
      trace("autosize empty", autoE.width, autoE.height);
      var t:TextField;
      var i:TextFormat = new TextFormat("Probe", 20);
      i.indent = 10;
      i.blockIndent = 4;
      t = new TextField();
      t.embedFonts = true;
      t.wordWrap = true;
      t.width = 80;
      t.defaultTextFormat = i;
      t.text = "ab ab ab ab\rab";
      addChild(t);
      trace("indent wrap", t.textHeight, t.getLineMetrics(0).x, t.getCharBoundaries(6), t.getCharBoundaries(12), t.getLineLength(0));
            var ls:TextFormat = new TextFormat("Probe", 20);
      ls.letterSpacing = -3;
      t = field2("azb", ls);
      trace("negative spacing, missing", t.textWidth, t.getCharBoundaries(0), t.getCharBoundaries(2));
      t = field2("ab", new TextFormat("Probe", 20));
      t.htmlText = "<font size='30'>a</font><font size='10'>b</font>";
      trace("two sizes", t.textWidth, t.textHeight, t.getLineMetrics(0).ascent, t.getLineMetrics(0).descent, t.getCharBoundaries(0), t.getCharBoundaries(1));
      trace("sizes", new TextFormat("Probe", 10.5).size, new TextFormat("Probe", 11.5).size, new TextFormat("Probe", 12.5).size);
      t = field2("ab", new TextFormat("Missing", 20));
      trace("missing font:", t.textWidth, t.textHeight, t.getCharBoundaries(0), t.numLines, t.getLineMetrics(0).height);
    }
  }
}
