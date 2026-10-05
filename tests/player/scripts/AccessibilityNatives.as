package {
  import flash.accessibility.Accessibility;
  import flash.display.Sprite;

  public class AccessibilityNatives extends Sprite {
    public function AccessibilityNatives() {
      trace("active " + Accessibility.active);
      try {
        Accessibility.updateProperties();
        trace("properties updated");
      } catch (e:Error) {
        trace("update " + e);
      }
      try {
        Accessibility.sendEvent(this, 1, 32770, false);
        trace("event sent");
      } catch (e:Error) {
        trace("send " + e);
      }
      try {
        Accessibility.sendEvent(null, 0, 0, true);
        trace("null event sent");
      } catch (e:Error) {
        trace("null send " + e);
      }
    }
  }
}
