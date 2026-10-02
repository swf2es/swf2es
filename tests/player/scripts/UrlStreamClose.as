package {
  import flash.display.Sprite;
  import flash.net.URLStream;

  public class UrlStreamClose extends Sprite {
    public function UrlStreamClose() {
      var stream:URLStream = new URLStream();
      try { stream.close(); trace("first", "ok"); }
      catch (e:Error) { trace("first", e.errorID); }
      try { stream.close(); trace("second", "ok"); }
      catch (e:Error) { trace("second", e.errorID); }
    }
  }
}
