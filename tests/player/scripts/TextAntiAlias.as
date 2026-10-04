package {
  import flash.display.Sprite;
  import flash.filters.DropShadowFilter;
  import flash.text.TextField;
  import flash.text.TextFormat;

  public class TextAntiAlias extends Sprite {
    public function TextAntiAlias() {
      for (var i:int = 0; i < 4; i++) {
        var field:TextField = new TextField();
        field.defaultTextFormat = new TextFormat("Probe", 11, 0x00ffff);
        field.embedFonts = true;
        field.antiAliasType = i % 2 == 0 ? "normal" : "advanced";
        field.gridFitType = "pixel";
        field.width = 180;
        field.height = 28;
        field.text = "abc Wabc";
        field.x = 4;
        field.y = 4 + i * 27;
        if (i >= 2) {
          field.filters = [new DropShadowFilter(0, 45, 0, 1, 3, 3, 5, 1)];
        }
        addChild(field);
      }
      trace("drawn");
    }
  }
}
