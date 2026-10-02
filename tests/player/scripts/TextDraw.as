package {
  import flash.display.*;
  import flash.text.*;

  // Text drawn in an embedded font of rectangles (cases.ts's "Probe"):
  // its glyphs placed as the layout has them, in each run's size and
  // colour, wrapped, aligned, scrolled and clipped to the field.
  public class TextDraw extends Sprite {
    private function field(x:Number, y:Number, w:Number, h:Number, f:TextFormat, html:String, wrap:Boolean = false):TextField {
      var t:TextField = new TextField();
      t.wordWrap = wrap;
      t.embedFonts = true;
      t.multiline = true;
      t.x = x;
      t.y = y;
      t.width = w;
      t.height = h;
      t.border = true;
      t.defaultTextFormat = f;
      t.htmlText = html;
      addChild(t);
      return t;
    }

    public function TextDraw() {
      field(5, 5, 120, 40, new TextFormat("Probe", 20, 0x0000ff), "abcW cab");
      field(130, 5, 120, 40, new TextFormat("Probe", 20, 0, null, null, null, null, null, "right"), "ab ab");
      field(255, 5, 140, 40, new TextFormat("Probe", 12), "a<font size='30' color='#ff0000'>b</font>c <font color='#00aa00'>W</font>");
      var wrap:TextField = field(5, 50, 80, 80, new TextFormat("Probe", 16), "ab ab abab ab cab", true);
      var kern:TextFormat = new TextFormat("Probe", 24);
      kern.kerning = true;
      field(90, 50, 100, 30, kern, "abab");
      var centre:TextFormat = new TextFormat("Probe", 16);
      centre.align = "center";
      centre.leading = 4;
      field(90, 85, 100, 60, centre, "ab<br>abc<br>W");
      var scrolled:TextField = field(195, 50, 100, 40, new TextFormat("Probe", 16), "ab<br>cab<br>W<br>bb");
      scrolled.scrollV = 2;
      field(300, 50, 40, 25, new TextFormat("Probe", 20), "abWab");
      var bg:TextField = field(300, 80, 90, 30, new TextFormat("Probe", 14, 0xffffff), "cab ab");
      bg.background = true;
      bg.backgroundColor = 0x203040;
      trace("drawn", wrap.numLines, scrolled.scrollV, scrolled.bottomScrollV);
    }
  }
}
