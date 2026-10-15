// Display objects whose shadow, bevel or gradient filter is cast past what adl
// holds, or by NaN: the stage keeps rendering. What Flash draws of them is
// its own wrapped arithmetic, so a cover hides them, and what is shown is
// what is drawn after them.
package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.filters.BevelFilter;
  import flash.filters.DropShadowFilter;
  import flash.filters.GradientBevelFilter;
  import flash.filters.GradientGlowFilter;

  public class Main extends Sprite {
    public function Main() {
      var filters:Array = [new DropShadowFilter(1e9, 0, 0, 1, 2, 2), new GradientGlowFilter(NaN, 45, [0, 0xff], [0, 1], [0, 255], 4, 4, 1, 1, "outer"),
        new BevelFilter(1e9, 0, 0xffffff, 1, 0, 1, 2, 2), new GradientGlowFilter(1e9, 0, [0, 0xff], [0, 1], [0, 255], 4, 4, 1, 1, "outer"),
        new GradientBevelFilter(1e20, 45, [0, 0xff], [1, 1], [0, 255], 4, 4, 1, 1, "inner"), new DropShadowFilter(Infinity, 45, 0, 1, 2, 2),
        new GradientGlowFilter(1e5, 180, [0, 0xff], [0, 1], [0, 255], 4, 4, 1, 1, "full"), new DropShadowFilter(4, 45, 0, 1, 2, 2)];
      for (var i:int = 0; i < filters.length; i++) {
        var s:Shape = new Shape();
        s.graphics.beginFill(0xff0000);
        s.graphics.drawRect(0, 0, 12, 12);
        s.x = 6 + (i % 4) * 20;
        s.y = 6 + int(i / 4) * 24;
        s.filters = [filters[i]];
        addChild(s);
      }
      var cover:Shape = new Shape();
      cover.graphics.beginFill(0xffffff);
      cover.graphics.drawRect(0, 0, 80, 60);
      addChild(cover);
      var usual:Shape = new Shape();
      usual.graphics.beginFill(0xff0000);
      usual.graphics.drawRect(30, 20, 12, 12);
      addChild(usual);
      var plain:Shape = new Shape();
      plain.graphics.beginFill(0x00ff00);
      plain.graphics.drawRect(0, 52, 80, 6);
      addChild(plain);
      trace("filters", filters.length);
    }
  }
}
