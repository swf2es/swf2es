package {
  import flash.display.Sprite;
  import flash.text.Font;
  import flash.utils.getDefinitionByName;

  public class FontNatives extends Sprite {
    public function FontNatives() {
      var cls:Class = getDefinitionByName("EmbeddedProbe") as Class;
      var font:Font = new cls() as Font;
      trace("instance", font.fontName, font.fontStyle, font.fontType);
      trace("glyphs", font.hasGlyphs("ab"), font.hasGlyphs("z"), font.hasGlyphs(""));
      trace("before", listed());
      Font.registerFont(cls);
      trace("after", listed());
      Font.registerFont(cls);
      trace("twice", listed());
      trace("device flag", listedWithDevice());
      var plain:Font = new Font();
      trace("plain", plain.fontName, plain.fontStyle, plain.fontType,
        plain.hasGlyphs("a"), plain.hasGlyphs(""));
      try { Font.registerFont(Sprite); trace("invalid", "accepted"); }
      catch (e:Error) { trace("invalid", e.toString()); }
      try { Font.registerFont(Font); trace("base", "accepted"); }
      catch (e:Error) { trace("base", e.toString()); }
      try { Font.registerFont(BareFont); trace("unbound", "accepted"); }
      catch (e:Error) { trace("unbound", e.toString()); }
    }

    private function listed():String {
      var result:Array = [];
      for each (var font:Font in Font.enumerateFonts(false)) {
        if (font.fontName == "Probe") {
          result.push(font.fontName + ":" + font.fontStyle + ":" + font.fontType);
        }
      }
      return result.join(",");
    }

    private function listedWithDevice():String {
      var result:Array = [];
      for each (var font:Font in Font.enumerateFonts(true)) {
        if (font.fontName == "Probe") {
          result.push(font.fontName + ":" + font.fontStyle + ":" + font.fontType);
        }
      }
      return result.join(",");
    }
  }

  class BareFont extends Font {}
}
