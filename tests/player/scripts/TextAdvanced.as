package {
  import flash.display.*;
  import flash.geom.*;
  import flash.text.*;

  // Text in "Stem" (cases.ts), a font of upright bars of six widths, drawn
  // and laid out with each antiAliasType, gridFitType, thickness and
  // sharpness: Flash's advanced anti-aliasing (Saffron) moves stems onto
  // the pixel grid and thickens or thins them, and lays advanced text out
  // with its pen in fractions of a twip, letter spacing, kerning and mixed
  // sizes too. The player lays it out so (text-advanced-layout) and draws
  // it so (text-advanced).
  public class TextAdvanced extends Sprite {
    private static const SIZES:Array = [10, 12, 14, 20, 24];
    private static const MODES:Array = [
      ["normal", "pixel", 0, 0],
      ["advanced", "pixel", 0, 0],
      ["advanced", "none", 0, 0],
      ["advanced", "subpixel", 0, 0],
      ["advanced", "pixel", -200, 0],
      ["advanced", "pixel", 200, 0],
      ["advanced", "pixel", 0, -400],
      ["advanced", "pixel", 0, 400]
    ];

    private function field(size:Number, mode:Array, color:uint, text:String, format:TextFormat = null):TextField {
      var t:TextField = new TextField();
      t.embedFonts = true;
      t.antiAliasType = mode[0];
      t.gridFitType = mode[1];
      t.thickness = mode[2];
      t.sharpness = mode[3];
      t.defaultTextFormat = format || new TextFormat("Stem", size, color);
      t.autoSize = TextFieldAutoSize.LEFT;
      t.text = text;
      return t;
    }

    private function widths(t:TextField):String {
      var out:Array = [];
      for (var i:int = 0; i < t.length; i++) {
        var b:Rectangle = t.getCharBoundaries(i);
        out.push(b ? Math.round(b.width * 20) : "-");
      }

      return out.join(",");
    }

    public function TextAdvanced() {
      // Kerning, in sizes no other field here uses: adl's advanced,
      // pixel-fitted text keeps a word's layout from one field to another
      // of the same size whether kerned or not. The pair ends the text:
      // before another character adl's boundaries give it to the pair's
      // first.
      for (var km:int = 0; km < 3; km++) {
        for each (var ks:Number in [11, 22]) {
          var kerned:TextFormat = new TextFormat("Stem", ks);
          kerned.kerning = true;
          var kt:TextField = field(ks, MODES[km], 0, "lmal", kerned);
          kt.y = 400;
          addChild(kt);
          trace(MODES[km][0], MODES[km][1], ks, "kerning", "tw", kt.textWidth, "w", widths(kt));
        }
      }

      var bar:Shape = new Shape();
      bar.graphics.beginFill(0xcc2222);
      bar.graphics.drawRect(0, 0, 200, 212);
      addChild(bar);

      // Each mode in a row: white on red at 20 pixels, black on white at 12,
      // both off the pixel grid.
      for (var r:int = 0; r < MODES.length; r++) {
        var big:TextField = field(20, MODES[r], 0xffffff, "123456 lm");
        big.x = 2.3;
        big.y = 2 + r * 26;
        addChild(big);
        var small:TextField = field(12, MODES[r], 0, "123456 lm 123456");
        small.x = 204.3;
        small.y = 6 + r * 26;
        addChild(small);
      }

      // Wrapped in 12 pixels, normal and advanced.
      for (var k:int = 0; k < 2; k++) {
        var wrap:TextField = field(12, MODES[k], 0, "");
        wrap.autoSize = TextFieldAutoSize.NONE;
        wrap.wordWrap = true;
        wrap.multiline = true;
        wrap.x = 2 + k * 200;
        wrap.y = 214;
        wrap.width = 196;
        wrap.height = 84;
        wrap.text = "lma 1lm 2am3 lll4 mm5 al6 lmaml 13 am2m lamla m4m5 6lam l2l3 malm";
        addChild(wrap);
        trace("wrap", MODES[k].join("/"), wrap.numLines, wrap.textWidth);
      }

      // Advances: each mode at each size, laid out away from the stage.
      for (var m:int = 0; m < 4; m++) {
        for (var s:int = 0; s < SIZES.length; s++) {
          var t:TextField = field(SIZES[s], MODES[m], 0, "lmalmaW 1ll2");
          t.y = 400;
          addChild(t);
          trace(MODES[m][0], MODES[m][1], SIZES[s], "tw", t.textWidth, "w", widths(t));
        }
      }

      // Letter spacing in fractions of a pixel and sizes mixed in one
      // line, normal and advanced.
      for (m = 0; m < 3; m++) {
        for each (var size:Number in [12, 20]) {
          for each (var spacing:Number in [0.3, 1.7, -0.6]) {
            var spaced:TextFormat = new TextFormat("Stem", size);
            spaced.letterSpacing = spacing;
            var st:TextField = field(size, MODES[m], 0, "lmalmaW 1ll2", spaced);
            st.y = 400;
            addChild(st);
            trace(MODES[m][0], MODES[m][1], size, "spacing", spacing, "tw", st.textWidth, "w", widths(st));
          }

        }

        var mixed:TextField = field(12, MODES[m], 0, "");
        mixed.htmlText = "<font size='10'>lma</font><font size='13'>lma</font><font size='17'>lmW</font>";
        mixed.y = 400;
        addChild(mixed);
        trace(MODES[m][0], MODES[m][1], "mixed", "tw", mixed.textWidth, "w", widths(mixed));
      }
    }
  }
}
