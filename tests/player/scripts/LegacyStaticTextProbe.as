package {
  import flash.display.*;

  public class LegacyStaticTextProbe extends Sprite {
    public function LegacyStaticTextProbe() {
      for (var i:int = 0; i < numChildren; i++) {
        var text:Object = getChildAt(i);
        trace(i, JSON.stringify(text.text));
      }
    }
  }
}
