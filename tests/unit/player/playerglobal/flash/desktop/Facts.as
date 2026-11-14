package {
  import flash.desktop.NativeApplication;
  import flash.display.NativeWindow;
  import flash.display.Sprite;
  import flash.geom.Point;

  public class Facts extends Sprite {
    public function Facts() {
      var a:NativeApplication = NativeApplication.nativeApplication;
      trace("app", a.runtimeVersion, a.runtimePatchLevel, a.applicationID, "[" + a.publisherID + "]", a.autoExit, a.idleThreshold, a.systemIdleMode, a.executeInBackground, a.menu);
      try {
        trace(a.startAtLogin);
      } catch (e:Error) {
        trace("startAtLogin", e.errorID);
      }
      var w:NativeWindow = stage.nativeWindow;
      trace("windows", a.openedWindows.length, a.openedWindows[0] == w, a.activeWindow == w);
      trace("descriptor", a.applicationDescriptor.name(), a.applicationDescriptor.children().length());
      trace("window", w.width, w.height, w.x, w.y, w.title, w.displayState, w.active, w.visible, w.closed, w.stage == stage);
      trace("chrome", w.systemChrome, w.transparent, w.type, w.minimizable, w.maximizable, w.resizable, w.alwaysInFront, w.menu);
      trace("screen", w.globalToScreen(new Point(10, 20)));
      w.title = "Changed";
      w.width = 420;
      trace("after set", w.title, w.width, w.height, w.bounds);
      a.exit(3);
    }
  }
}
