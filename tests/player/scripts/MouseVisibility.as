package {
  import flash.display.Sprite;
  import flash.ui.Mouse;

  public class MouseVisibility extends Sprite {
    public function MouseVisibility() {
      Mouse.hide();
      trace("hidden");
      Mouse.hide();
      trace("hidden twice");
      Mouse.show();
      trace("shown");
      Mouse.show();
      trace("shown twice");
    }
  }
}
