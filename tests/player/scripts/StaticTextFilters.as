package {
  import flash.display.*;
  import flash.filters.*;

  // A timeline's static text given filters by a script: a sharp shadow a
  // pixel down and a wide dark glow, as a button's caption might have.
  public class StaticTextFilters extends Sprite {
    public function StaticTextFilters() {
      var text:DisplayObject = getChildAt(1);
      trace(text, (text as Object).text);
      text.filters = [
        new DropShadowFilter(1, 90, 0x000000, 1, 0, 0, 1, 3),
        new DropShadowFilter(0, 90, 0x53390f, 1, 10, 10, 1, 3)
      ];
    }
  }
}
