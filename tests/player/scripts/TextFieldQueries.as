package {
  import flash.display.Sprite;
  import flash.text.Font;
  import flash.text.TextField;
  import flash.utils.getDefinitionByName;

  // TextField.isFontCompatible against the SWF's fonts, Probe regular and
  // BoldProbe bold, before and after registering one; and
  // getImageReference, which adl gives null for every IMG.
  public class TextFieldQueries extends Sprite {
    public function TextFieldQueries() {
      compatible("before");
      Font.registerFont(getDefinitionByName("EmbeddedBold") as Class);
      compatible("registered");

      var field:TextField = new TextField();
      field.multiline = true;
      addChild(field);
      trace("no images", field.getImageReference("a"));
      field.htmlText = 'x<img id="a" src="TextFieldQueries" width="20" height="20">y' +
        '<img id="b" src="missing.png">z';
      trace("text", field.text, field.length);
      trace("images", field.getImageReference("a"), field.getImageReference("b"),
        field.getImageReference(""));
      try {
        field.getImageReference(null);
      } catch (e:Error) {
        trace("null id", e);
      }
    }

    private function compatible(label:String):void {
      var out:Array = [];
      for each (var name:String in ["Probe", "probe", "PROBE", "BoldProbe", "Missing", "_sans", "",
          null]) {
        for each (var style:String in ["regular", "bold", "italic", "boldItalic", "Bold", "plain",
            "", null]) {
          out.push(name + "/" + style + "=" + TextField.isFontCompatible(name, style));
        }
      }

      trace(label, out.join(" "));
    }
  }
}
