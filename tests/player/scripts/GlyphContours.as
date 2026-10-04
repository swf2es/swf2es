package {
  import flash.display.*;
  import flash.text.*;

  // A pixel font's glyphs whose contours touch (cases.ts's "Pixel"): the
  // "a"'s top bar a contour of its own, its bottom edge along the corners
  // of the outline below it, is filled, not cut from it as a hole; the
  // "b"'s holes are cut.
  public class GlyphContours extends Sprite {
    private function field(x:Number, y:Number, size:int, color:uint, text:String):TextField {
      var t:TextField = new TextField();
      t.embedFonts = true;
      t.autoSize = "left";
      t.x = x;
      t.y = y;
      t.defaultTextFormat = new TextFormat("Pixel", size, color);
      t.text = text;
      addChild(t);
      return t;
    }

    public function GlyphContours() {
      var small:TextField = field(5, 5, 8, 0x000000, "bikbokbak");
      var mid:TextField = field(5, 20, 16, 0xcc2200, "ab ka [ab]");
      var large:TextField = field(5, 50, 32, 0x0044aa, "akab");
      trace("drawn", small.textWidth, mid.textWidth, large.textWidth, large.textHeight);
    }
  }
}
