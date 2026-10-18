package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;
  import flash.text.*;

  // Advanced text drawn as Flash draws it, beyond text-advanced: Stem
  // (cases.ts) with its CSM hint thin (no alignment zones), medium
  // (StemM) and thick (StemT), light and dark; scaled and turned; under a
  // colour transform, a filter and a mask; drawn into a BitmapData; and
  // StemTable by a table of its own.
  public class TextAdvancedDraw extends Sprite {
    private function field(font:String, size:Number, color:uint, text:String):TextField {
      var t:TextField = new TextField();
      t.embedFonts = true;
      t.antiAliasType = AntiAliasType.ADVANCED;
      t.gridFitType = GridFitType.NONE;
      t.defaultTextFormat = new TextFormat(font, size, color);
      t.autoSize = TextFieldAutoSize.LEFT;
      t.text = text;
      return t;
    }

    private function box(x:Number, y:Number, w:Number, h:Number, color:uint):void {
      graphics.beginFill(color);
      graphics.drawRect(x, y, w, h);
      graphics.endFill();
    }

    public function TextAdvancedDraw() {
      TextRenderer.setAdvancedAntiAliasingTable("StemTable", FontStyle.REGULAR, TextColorType.DARK_COLOR, [
        new CSMSettings(10, 0.6, -0.6),
        new CSMSettings(30, 0.2, -1.4)
      ]);

      box(0, 0, 200, 132, 0x223355);
      var fonts:Array = ["Stem", "StemM", "StemT"];
      var sizes:Array = [12, 20];
      var y:Number = 1;
      for (var f:int = 0; f < fonts.length; f++) {
        for (var s:int = 0; s < sizes.length; s++) {
          var light:TextField = field(fonts[f], sizes[s], 0xffffff, "123456 lmaW");
          light.x = 4;
          light.y = y;
          addChild(light);
          var dark:TextField = field(fonts[f], sizes[s], 0x000000, "123456 lmaW");
          dark.x = 204;
          dark.y = y;
          addChild(dark);
          y += sizes[s] + 4;
        }
      }

      // Scaled one and a half times, and turned.
      box(0, 134, 200, 40, 0x223355);
      var holder:Sprite = new Sprite();
      holder.x = 4;
      holder.y = 136;
      holder.scaleX = holder.scaleY = 1.5;
      holder.addChild(field("Stem", 12, 0xffffff, "123456 lm"));
      addChild(holder);
      var turned:TextField = field("Stem", 16, 0x000000, "123456 lmaW");
      turned.x = 206;
      turned.y = 134;
      turned.rotation = 8;
      addChild(turned);

      // Under a colour transform, offsets and all.
      box(0, 176, 200, 30, 0x223355);
      var colored:TextField = field("Stem", 20, 0xffffff, "123456 lm");
      colored.x = 4;
      colored.y = 177;
      colored.transform.colorTransform = new ColorTransform(0.5, 1, 1, 1, 0, -60, 40, 0);
      addChild(colored);

      // StemTable by its own table, at two sizes.
      var tabled:TextField = field("StemTable", 14, 0x000000, "123456 lm");
      tabled.x = 204;
      tabled.y = 178;
      addChild(tabled);
      var tabledBig:TextField = field("StemTable", 24, 0x000000, "1234 lm");
      tabledBig.x = 300;
      tabledBig.y = 172;
      addChild(tabledBig);

      // A glow, and a mask over half of a field.
      var glowing:TextField = field("Stem", 16, 0x000000, "123456 lm");
      glowing.x = 4;
      glowing.y = 210;
      glowing.filters = [new GlowFilter(0xff0000, 1, 4, 4, 2)];
      addChild(glowing);
      var masked:TextField = field("Stem", 16, 0x000000, "123456 lmaW");
      masked.x = 104;
      masked.y = 210;
      addChild(masked);
      var mask:Shape = new Shape();
      mask.graphics.beginFill(0);
      mask.graphics.drawRect(104, 210, 47, 30);
      addChild(mask);
      masked.mask = mask;

      // Drawn into a BitmapData, shown at once.
      var drawn:TextField = field("Stem", 20, 0x000000, "123456 lm");
      var bitmap:BitmapData = new BitmapData(110, 30, false, 0xffffcc);
      bitmap.draw(drawn, new Matrix(1, 0, 0, 1, 3, 2));
      var shown:Bitmap = new Bitmap(bitmap);
      shown.x = 204;
      shown.y = 210;
      addChild(shown);
      trace("drawn", numChildren);
    }
  }
}
