package {
  import flash.display.Screen;
  import flash.display.Sprite;
  import flash.geom.Rectangle;

  public class Two extends Sprite {
    private function found(x:Number, y:Number, width:Number, height:Number):String {
      var screens:Array = Screen.getScreensForRectangle(new Rectangle(x, y, width, height));
      var names:Array = [];
      for (var i:int = 0; i < screens.length; i++) {
        names.push(screens[i].bounds.x < 0 ? "left" : "main");
      }

      return "[" + names.join(",") + "]";
    }

    public function Two() {
      var screens:Array = Screen.screens;
      trace("screens", screens.length, screens[0].bounds, screens[0].visibleBounds, screens[0].colorDepth);
      trace("second", screens[1].bounds, screens[1].visibleBounds, screens[1].colorDepth);
      trace("main", Screen.mainScreen.bounds, Screen.mainScreen.visibleBounds);
      trace("on one", found(-1000, 100, 200, 200), found(100, 100, 200, 200), found(100, 1030, 50, 50));
      trace("on both", found(-100, 100, 200, 200), found(-5000, -5000, 10000, 10000));
      trace("at the seam", found(-10, 0, 10, 10), found(0, 0, 10, 10), found(-1, 0, 2, 10), found(-0.5, 0, 0.5, 10));
      trace("on none", found(-1000, 1030, 50, 50), found(-1280, 1024, 1280, 56), found(1920, 0, 10, 10), found(-1290, 0, 10, 10), found(-100, 100, 0, 200), found(-100, 100, 200, -1));
      trace("in the free part's gap", found(100, 1050, 10, 10));
      try {
        trace(Screen.getScreensForRectangle(null));
      } catch (e:Error) {
        trace("null", e);
      }
    }
  }
}
