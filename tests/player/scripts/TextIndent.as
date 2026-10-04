package {
  import flash.display.*;
  import flash.geom.Rectangle;
  import flash.text.*;

  // Chat lines in fields authored with a hanging indent, a left margin of
  // 10 and an indent of -10 (cases.ts's "text-indent"): the tag keeps the
  // indent in 16 bits, signed, so each paragraph's first line starts at
  // the gutter, with no more room than the next, and its wrapped lines 10
  // pixels in. One field is set again from another's htmlText, as a chat
  // that draws each line in a field of its own does; a script's field puts
  // its indent past its margin, which stops at the gutter.
  //
  // Not traced, where swf2es still parts from adl: an authored field's
  // character boundaries, 2 pixels further right and down than its
  // lines' in adl, and the htmlText of text set to end in a <br>, where
  // adl adds an empty FONT of the newline's colour.
  public class TextIndent extends Sprite {
    private static function box(r:Rectangle):String {
      return r ? [r.x, r.y, r.width, r.height].join(" ") : "null";
    }

    private static function show(name:String, t:TextField, authored:Boolean, html:Boolean):void {
      var f:TextFormat = t.getTextFormat(0, 1);
      trace(name, "format", f.leftMargin, f.indent, t.defaultTextFormat.leftMargin, t.defaultTextFormat.indent);
      trace(name, "text", t.text.split("\r").join("|"));
      if (html) {
        trace(name, "html", t.htmlText);
      }
      var lines:Array = [];
      for (var i:int = 0; i < t.numLines; i++) {
        lines.push(t.getLineOffset(i) + ":" + t.getLineMetrics(i).x + ":" + t.getLineText(i));
      }
      trace(name, "lines", t.numLines, lines.join("|"));
      if (!authored) {
        trace(name, "first", box(t.getCharBoundaries(0)), box(t.getCharBoundaries(1)));
      }
      trace(name, "size", t.textWidth, t.textHeight, t.width, t.height, t.scrollH, t.maxScrollH);
    }

    public function TextIndent() {
      var a:TextField = getChildAt(0) as TextField;
      var b:TextField = getChildAt(1) as TextField;
      var c:TextField = getChildAt(2) as TextField;
      trace("authored", a.text.length, a.defaultTextFormat.leftMargin, a.defaultTextFormat.indent);
      a.htmlText = "<font color=\"#cc6600\">[ab] kab ab ba bak ab ba kab ab bak</font><br>";
      a.autoSize = "left";
      show("a", a, true, false);
      b.htmlText = "<font color=\"#008888\">kab bak ab.</font><br>";
      b.autoSize = "left";
      show("b", b, true, false);
      c.htmlText = a.htmlText;
      c.autoSize = "left";
      c.multiline = true;
      show("c", c, true, true);

      var d:TextField = new TextField();
      d.embedFonts = true;
      d.multiline = true;
      d.wordWrap = true;
      d.border = true;
      d.x = 215;
      d.y = 5;
      d.width = 200;
      d.height = 60;
      var format:TextFormat = new TextFormat("Pixel", 16, 0x8040c0);
      format.indent = -10;
      d.defaultTextFormat = format;
      d.text = "ab ka ba bak ab ba ka ab ab";
      addChild(d);
      show("d", d, false, true);

      var e:TextField = new TextField();
      e.embedFonts = true;
      e.multiline = true;
      e.wordWrap = true;
      e.border = true;
      e.x = 215;
      e.y = 70;
      e.width = 200;
      e.height = 60;
      e.defaultTextFormat = new TextFormat("Pixel", 16, 0x2060a0);
      e.htmlText = "<textformat leftmargin=\"20\" indent=\"-14\">ab ka ba bak ab ba kab ab</textformat>";
      addChild(e);
      show("e", e, false, true);
    }
  }
}
