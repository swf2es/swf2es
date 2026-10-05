package {
  import flash.display.Sprite;
  import flash.text.engine.FontDescription;

  public class FontDescriptionNatives extends Sprite {
    public function FontDescriptionNatives() {
      trace("start");
      var font:FontDescription = new FontDescription();
      trace("defaults", font.fontName, font.fontWeight, font.fontPosture,
        font.fontLookup, font.renderingMode, font.cffHinting, font.locked);

      var names:Array = ["fontName", "fontWeight", "fontPosture", "fontLookup",
        "renderingMode", "cffHinting"];
      for each (var name:String in names) {
        try { font[name] = null; trace(name, "null accepted"); }
        catch (e:Error) { trace(name, "null", e.toString()); }
        try { font[name] = "invalid"; trace(name, "invalid accepted", font[name]); }
        catch (e:Error) { trace(name, "invalid", e.toString()); }
      }

      font.fontName = "Example";
      font.fontWeight = "bold";
      font.fontPosture = "italic";
      font.fontLookup = "embeddedCFF";
      font.renderingMode = "normal";
      font.cffHinting = "none";
      trace("changed", font.fontName, font.fontWeight, font.fontPosture,
        font.fontLookup, font.renderingMode, font.cffHinting);

      font.locked = true;
      try { font.fontName = "Other"; trace("locked name accepted"); }
      catch (e:Error) { trace("locked name", e.toString()); }
      try { font.fontWeight = "normal"; trace("locked weight accepted"); }
      catch (e:Error) { trace("locked weight", e.toString()); }
      try { font.fontPosture = null; trace("locked null accepted"); }
      catch (e:Error) { trace("locked null", e.toString()); }
      try { font.fontLookup = "invalid"; trace("locked invalid accepted"); }
      catch (e:Error) { trace("locked invalid", e.toString()); }
      try { font.locked = false; trace("unlocked", font.locked); }
      catch (e:Error) { trace("unlock", e.toString()); }
      try { font.locked = true; trace("relocked", font.locked); }
      catch (e:Error) { trace("relock", e.toString()); }
      var clone:FontDescription = font.clone();
      trace("clone", clone.fontName, clone.fontWeight, clone.locked);

      trace("compatible", FontDescription.isFontCompatible("_serif", "normal", "normal"),
        FontDescription.isFontCompatible("DefinitelyNotAFont", "normal", "normal"));
      trace("device compatible",
        FontDescription.isDeviceFontCompatible("_serif", "normal", "normal"),
        FontDescription.isDeviceFontCompatible("DefinitelyNotAFont", "normal", "normal"));
      trace("known fonts", FontDescription.isFontCompatible("Arial", "normal", "normal"),
        FontDescription.isDeviceFontCompatible("Arial", "normal", "normal"),
        FontDescription.isFontCompatible("_sans", "normal", "normal"));
      trace("generic devices", FontDescription.isDeviceFontCompatible("_sans", "normal", "normal"),
        FontDescription.isDeviceFontCompatible("_serif", "normal", "normal"),
        FontDescription.isDeviceFontCompatible("_typewriter", "normal", "normal"));
      try { trace("bad static", FontDescription.isFontCompatible(null, "normal", "normal")); }
      catch (e:Error) { trace("bad static", e.toString()); }
      try { trace("bad device", FontDescription.isDeviceFontCompatible("Arial", "bad", "normal")); }
      catch (e:Error) { trace("bad device", e.toString()); }
      try { trace("bad compatible weight", FontDescription.isFontCompatible("Arial", "bad", "normal")); }
      catch (e:Error) { trace("bad compatible weight", e.toString()); }
      try { trace("bad compatible posture", FontDescription.isFontCompatible("Arial", "normal", "bad")); }
      catch (e:Error) { trace("bad compatible posture", e.toString()); }
      try { trace("null device", FontDescription.isDeviceFontCompatible(null, "normal", "normal")); }
      catch (e:Error) { trace("null device", e.toString()); }
      try { trace("null weight", FontDescription.isFontCompatible("Arial", null, "normal")); }
      catch (e:Error) { trace("null weight", e.toString()); }
      try { trace("null name bad weight", FontDescription.isFontCompatible(null, "bad", "normal")); }
      catch (e:Error) { trace("null name bad weight", e.toString()); }
    }
  }
}
