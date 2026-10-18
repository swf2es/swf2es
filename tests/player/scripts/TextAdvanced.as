package {
  import flash.display.*;
  import flash.geom.*;
  import flash.text.*;

  // Text in "Stem" (cases.ts), a font of upright bars of six widths, drawn
  // and laid out with each antiAliasType, gridFitType, thickness and
  // sharpness: Flash's advanced anti-aliasing (Saffron) moves stems onto
  // the pixel grid and thickens or thins them, and lays advanced text out
  // with its pen in fractions of a twip. The player has neither yet: a
  // known gap, out of the default run.
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

    private function field(size:Number, mode:Array, color:uint, text:String):TextField {
      var t:TextField = new TextField();
      t.embedFonts = true;
      t.antiAliasType = mode[0];
      t.gridFitType = mode[1];
      t.thickness = mode[2];
      t.sharpness = mode[3];
      t.defaultTextFormat = new TextFormat("Stem", size, color);
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
    }
  }
}
