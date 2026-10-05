package {
  import flash.display.MovieClip;
  import flash.text.TextField;
  import flash.text.TextFormat;

  public class LoadedFontInner extends MovieClip {
    public function LoadedFontInner() {
      var field:TextField = new TextField();
      field.embedFonts = true;
      field.defaultTextFormat = new TextFormat("Probe", 20, 0x000000);
      field.text = "A";
      trace("loaded font width", field.textWidth > 0);
      addChild(field);
    }
  }
}
