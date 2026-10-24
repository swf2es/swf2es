package {
  import flash.display.Sprite;
  import flash.text.TextField;

  public class TextLifecycle extends Sprite {
    public function TextLifecycle() {
      addChild(new TextLabel());
    }
  }

  internal class TextLabel extends Sprite {
    public function TextLabel() {
      var field:TextField = new TextField();
      field.width = 160;
      field.text = "Device font lifecycle";
      addChild(field);
    }
  }
}
