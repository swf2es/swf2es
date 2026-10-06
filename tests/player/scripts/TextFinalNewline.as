package {
  import flash.display.*;
  import flash.text.*;

  // The empty line a final newline leaves, "kab<br>" or "kab\r", and
  // whether textHeight, and so an autosized field's height, counts it
  // (cases.ts's "text-final-newline"): in authored fields, read-only
  // (dynamic) and not (input), in a script's of either type, and across
  // a type changed after the text. The picture is a chat: each message,
  // ending in a <br>, measured in a hidden autosized dynamic field and
  // drawn in a copy stacked up from the one below by that height; on the
  // right the same in input fields.
  public class TextFinalNewline extends Sprite {
    private static function line(name:String, t:TextField, kind:String):void {
      // textHeight first: adl's numLines can lag a relayout until something asks for one.
      var height:Number = t.textHeight;
      trace(name, t.type, t.wordWrap ? "wrap" : "nowrap", kind, t.text.split("\r").join("|"), height, t.numLines, t.height);
    }

    private static function probe(name:String, t:TextField):void {
      for each (var wrap:Boolean in [false, true]) {
        t.wordWrap = wrap;
        t.htmlText = "kab<br>";
        line(name, t, "html");
        t.text = "kab\r";
        line(name, t, "plain");
        t.text = "kab";
        line(name, t, "none");
      }
    }

    private static function script(type:String):TextField {
      var t:TextField = new TextField();
      t.embedFonts = true;
      t.multiline = true;
      t.autoSize = "left";
      t.visible = false;
      if (type) {
        t.type = type;
      }
      t.defaultTextFormat = new TextFormat("Pixel", 16, 0x000000);
      return t;
    }

    private static function stack(measure:TextField, copies:Array, messages:Array):void {
      var next:Number = 196;
      for (var i:int = messages.length - 1; i >= 0; i--) {
        measure.htmlText = messages[i];
        var copy:TextField = copies[i];
        copy.htmlText = messages[i];
        copy.autoSize = "left";
        copy.y = next - measure.height + 2;
        next = copy.y;
        trace("chat", copy.type, i, measure.textHeight, measure.height, copy.y);
      }
    }

    public function TextFinalNewline() {
      var a:TextField = getChildAt(0) as TextField;
      var b:TextField = getChildAt(1) as TextField;
      var f:TextField = getChildAt(2) as TextField;
      var m:TextField = getChildAt(3) as TextField;
      for each (var t:TextField in [a, b, f, m]) {
        t.autoSize = "left";
        t.visible = false;
      }

      probe("authored-dynamic", a);
      probe("authored-input", b);
      probe("script-default", script(null));
      probe("script-input", script(TextFieldType.INPUT));

      // The type changed after the text, with nothing set since.
      var e:TextField = script(null);
      e.htmlText = "kab<br>";
      line("script-switch", e, "html");
      e.type = TextFieldType.INPUT;
      line("script-switch", e, "html");
      e.type = TextFieldType.DYNAMIC;
      line("script-switch", e, "html");
      e.wordWrap = true;
      e.text = "kab\r";
      e.type = TextFieldType.INPUT;
      line("script-switch", e, "plain");

      f.htmlText = "kab<br>";
      line("authored-switch", f, "html");
      f.type = TextFieldType.DYNAMIC;
      line("authored-switch", f, "html");
      f.type = TextFieldType.INPUT;
      line("authored-switch", f, "html");
      a.htmlText = "kab<br>";
      a.type = TextFieldType.INPUT;
      line("authored-dynamic-switch", a, "html");
      a.type = TextFieldType.DYNAMIC;
      line("authored-dynamic-switch", a, "html");

      var messages:Array = [
        "<font color=\"#cc6600\">[ab] kab ab</font><br>",
        "<font color=\"#008888\">bak ab. kab ba</font><br>",
        "<font color=\"#8040c0\">ab ba kab bak ab ba kab ab bak ab ba</font><br>",
        "<font color=\"#2060a0\">[ko] bik ab</font><br>"
      ];
      var left:Array = [];
      var right:Array = [];
      for (var i:int = 0; i < messages.length; i++) {
        left.push(getChildAt(4 + i));
        right.push(getChildAt(4 + messages.length + i));
      }
      stack(m, left, messages);
      // The input column measures each message in its own field.
      for (i = 0; i < messages.length; i++) {
        var r:TextField = right[i];
        r.htmlText = messages[i];
        r.autoSize = "left";
      }
      var next:Number = 196;
      for (i = messages.length - 1; i >= 0; i--) {
        r = right[i];
        r.y = next - r.height + 2;
        next = r.y;
        trace("chat", r.type, i, r.textHeight, r.height, r.y);
      }
    }
  }
}
