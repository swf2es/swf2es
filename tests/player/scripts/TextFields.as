package {
  // TextField and TextFormat (cases.ts): their defaults, htmlText as Flash
  // writes and reads it, formats over ranges, and what each refuses.
  import flash.display.*;
  import flash.text.*;
  import flash.utils.getQualifiedClassName;
  public class TextFields extends Sprite {
    public function TextFields() {
      var f:TextFormat = new TextFormat();
      trace("format", f.font, f.size, f.color, f.bold, f.italic, f.underline, f.url, f.target, f.align, f.leftMargin, f.rightMargin, f.indent, f.leading, f.blockIndent, f.letterSpacing, f.kerning, f.bullet, f.tabStops, f.display);
      var g:TextFormat = new TextFormat("Verdana", 14, 0xFF0000, true, false, true, "http://x", "_blank", "center", 1, 2, 3, 4);
      trace("format2", g.font, g.size, g.color, g.bold, g.italic, g.underline, g.url, g.target, g.align, g.leftMargin, g.rightMargin, g.indent, g.leading);
      g.size = 12.7; g.color = -1; g.leading = -3.5; g.letterSpacing = 1.5;
      trace("format3", g.size, g.color, g.leading, g.letterSpacing);
      try { g.align = "bogus"; } catch (err:Error) { trace("align", getQualifiedClassName(err), err.errorID); }
      try { g.display = "bogus"; trace("display ok", g.display); } catch (err:Error) { trace("display", getQualifiedClassName(err), err.errorID); }
      g.align = null; g.font = null; g.bold = null;
      trace("nulls", g.align, g.font, g.bold);
      var t:TextField = new TextField();
      trace("field", t.width, t.height, t.text == "", t.length, t.border, t.borderColor, t.background, t.backgroundColor, t.multiline, t.wordWrap, t.type, t.embedFonts, t.autoSize, t.selectable, t.textColor, t.maxChars, t.displayAsPassword, t.condenseWhite, t.antiAliasType, t.gridFitType, t.sharpness, t.thickness, t.restrict, t.numLines, t.scrollV, t.maxScrollV, t.scrollH);
      var d:TextFormat = t.defaultTextFormat;
      trace("default", d.font, d.size, d.color, d.bold, d.italic, d.underline, d.url, d.target, d.align, d.leftMargin, d.rightMargin, d.indent, d.leading, d.blockIndent, d.letterSpacing, d.kerning, d.bullet);
      trace("html empty", t.htmlText);
      t.text = "abc";
      trace("html", t.htmlText);
      var e:TextFormat = t.getTextFormat();
      trace("got", e.font, e.size, e.color, e.bold, e.align, e.leading);
      t.textColor = 0x336699;
      trace("textColor", t.textColor, t.getTextFormat().color, t.defaultTextFormat.color);
      var b:TextFormat = new TextFormat(); b.bold = true; b.size = 20;
      t.setTextFormat(b);
      trace("after set", t.getTextFormat().bold, t.getTextFormat().size, t.defaultTextFormat.bold, t.htmlText);
      t.appendText("de");
      trace("append", t.text, t.getTextFormat(3, 5).bold, t.getTextFormat(0, 3).bold, t.getTextFormat().bold);
      var x:TextField = new TextField();
      x.defaultTextFormat = new TextFormat("Courier", 10, 0x00FF00);
      x.text = "hi";
      trace("dtf", x.getTextFormat().font, x.getTextFormat().size, x.getTextFormat().color, x.htmlText);
      x.htmlText = "<b>bo</b>ld <font color='#ff0000' size='20'>red</font><br>next<p>para</p>&amp;&lt;";
      trace("set html", x.text.split("\r").join("|"), x.length, x.htmlText);
      x.multiline = true;
      x.htmlText = "<p>one</p><p>two</p>";
      trace("multi html", x.text.split("\r").join("|"));
      x.text = "a\nb\rc";
      trace("newlines", x.text.split("\r").join("|"), x.length);
      for each (var bad:Array in [["type", "bogus"], ["autoSize", "bogus"], ["antiAliasType", "x"], ["gridFitType", "x"]]) {
        try { x[bad[0]] = bad[1]; trace(bad[0], "ok", x[bad[0]]); } catch (err:Error) { trace(bad[0], getQualifiedClassName(err), err.errorID); }
      }
      x.type = "input"; x.border = true; x.borderColor = 0x123456; x.background = true; x.backgroundColor = 0xABCDEF; x.wordWrap = true; x.embedFonts = true; x.autoSize = "left"; x.selectable = false;
      trace("set", x.type, x.border, x.borderColor, x.background, x.backgroundColor, x.wordWrap, x.embedFonts, x.autoSize, x.selectable);
      var y:TextField = new TextField();
      y.multiline = true;
      y.htmlText = "<p align='center'>one</p><textformat leading='4' indent='3'><p>two <i>it</i><u>und</u> <a href='http://a' target='_self'><b><i>link</i></b></a></p></textformat><li>dot</li>";
      trace("rich", y.text.split("\r").join("|"), y.htmlText);
      var z:TextFormat = new TextFormat(); z.italic = true; z.underline = true; z.url = "u"; z.leftMargin = 5;
      y.setTextFormat(z, 0, 2);
      trace("partial", y.htmlText);
      trace("mixed", y.getTextFormat(0, 5).italic, y.getTextFormat(0, 5).align, y.getTextFormat(0, 5).leading);
      try { t.getTextFormat(5, 2); trace("reverse ok"); } catch (err:Error) { trace("reverse", getQualifiedClassName(err), err.errorID); }
      try { t.getTextFormat(0, 99); trace("past ok"); } catch (err:Error) { trace("past", getQualifiedClassName(err), err.errorID); }
      try { t.setTextFormat(null); trace("null fmt ok"); } catch (err:Error) { trace("null fmt", getQualifiedClassName(err), err.errorID); }
      try { t.text = null; trace("null text ok"); } catch (err:Error) { trace("null text", getQualifiedClassName(err), err.errorID); }
    }
  }
}
