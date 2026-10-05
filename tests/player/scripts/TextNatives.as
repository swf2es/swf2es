package {
  import flash.display.Sprite;
  import flash.text.StyleSheet;
  import flash.text.TextField;
  import flash.text.TextFormat;
  import flash.text.TextRun;

  // StyleSheet's parsing and a field it styles, getTextRuns and the
  // paragraph methods. Not replaceSelectedText: adl's, on a field without
  // focus, inserts at a point of its own that setSelection does not move.
  public class TextNatives extends Sprite {
    public function TextNatives() {
      sheets();
      styled();
      runs();
      paragraphs();
    }

    private function style(o:Object):String {
      if (!o) {
        return String(o);
      }

      var keys:Array = [];
      for (var k:String in o) {
        keys.push(k + "=" + o[k]);
      }

      keys.sort();
      return "{" + keys.join(", ") + "}";
    }

    private function format(f:TextFormat):String {
      return [f.font, f.size, f.color, f.bold, f.italic, f.underline, f.align, f.leftMargin,
        f.leading, f.letterSpacing, f.kerning, f.display].join(" ");
    }

    private function sheets():void {
      var sheet:StyleSheet = new StyleSheet();
      sheet.parseCSS("/* a comment */ h1, .Big { font-size: 24px; color: #FF0000; font-family: sans-serif, Arial }\n" +
        "a:link { text-decoration: underline } KEY { margin-left: 5 } key { margin-left: 7 }");
      var names:Array = sheet.styleNames;
      names.sort();
      trace("names", names);
      trace("h1", style(sheet.getStyle("h1")));
      trace(".big", style(sheet.getStyle(".BIG")));
      trace("key", style(sheet.getStyle("key")));
      trace("missing", style(sheet.getStyle("missing")));
      trace("transform h1", format(sheet.transform(sheet.getStyle("h1"))));
      trace("transform odd", format(sheet.transform({leading: "x5", marginLeft: "3.7", color: "red",
        fontWeight: "bold", kerning: "true", display: "inline"})));
      trace("transform null", sheet.transform(null));
      sheet.parseCSS("broken { color: blue; }; this is not CSS");
      trace("after a broken sheet", style(sheet.getStyle("broken")));
      sheet.setStyle("Set", {color: "#00FF00"});
      trace("set", style(sheet.getStyle("set")));
      sheet.clear();
      trace("cleared", sheet.styleNames.length);

      var tf:TextFormat = new TextFormat();
      tf.leading = NaN;
      tf.indent = Infinity;
      trace("int NaN", tf.leading, tf.indent);
    }

    private function styled():void {
      var sheet:StyleSheet = new StyleSheet();
      sheet.setStyle(".red", {color: "#FF0000", fontWeight: "bold"});
      sheet.setStyle("p", {fontSize: "20"});
      sheet.setStyle("custom", {color: "#0000FF"});
      sheet.setStyle(".gone", {display: "none"});
      var field:TextField = new TextField();
      field.multiline = true;
      field.styleSheet = sheet;
      trace("sheet", field.styleSheet == sheet);
      field.htmlText = "<p>one <span class='red'>two</span></p><custom>three</custom>x<span class='gone'>hidden</span>y";
      trace("html", field.htmlText);
      trace("text", field.text.split("\r").join("|"));
      for each (var run:TextRun in field.getTextRuns()) {
        trace("  run", run.beginIndex, run.endIndex, run.textFormat.size, run.textFormat.color,
          run.textFormat.bold);
      }

      field.text = "<span class='red'>as text</span>";
      trace("text as html", field.text, field.getTextFormat(0, 1).color);
      sheet.setStyle(".red", {color: "#00FF00"});
      trace("restyled", field.getTextFormat(0, 1).color);
      try {
        field.replaceSelectedText("x");
      } catch (e:Error) {
        trace("replaceSelectedText with a sheet", e.errorID);
      }
      try {
        field.replaceText(0, 1, "x");
      } catch (e:Error) {
        trace("replaceText with a sheet", e.errorID);
      }
      field.styleSheet = null;
      trace("no sheet", field.styleSheet, field.htmlText);
    }

    private function runs():void {
      var field:TextField = new TextField();
      field.text = "abcdef";
      var bold:TextFormat = new TextFormat();
      bold.bold = true;
      field.setTextFormat(bold, 2, 4);
      for each (var run:TextRun in field.getTextRuns()) {
        trace("run", run.beginIndex, run.endIndex, run.textFormat.bold);
      }

      for each (run in field.getTextRuns(3, 5)) {
        trace("part", run.beginIndex, run.endIndex, run.textFormat.bold);
      }

      trace("empty", field.getTextRuns(4, 4).length, new TextField().getTextRuns().length);
    }

    private function paragraphs():void {
      var field:TextField = new TextField();
      field.multiline = true;
      field.text = "one\ntwo\n";
      for each (var i:int in [-1, 0, 2, 3, 4, 7, 8, 9]) {
        trace("paragraph", i, field.getFirstCharInParagraph(i), field.getParagraphLength(i));
      }
    }
  }
}
