// The Flash oracle's root mode: oracle/flash.ts puts this class's ABC first
// in a job's SWF, which adl then runs as the application's content, its
// root. Flash runs everything at its root SWF's API version, so a SWF the
// harness loads runs at the harness's; a job run as the root runs at its
// own. With no harness to load it, capture frames or tell its traces
// apart, this script, which runs as its ABC loads, before the SWF's own,
// does what it can of that from inside: it traces "\x01swf2es:begin 0"
// before the SWF's scripts run and "\x01swf2es:end 0" at the k-th
// EXIT_FRAME, k the frames the job runs, given in the InvokeEvent's
// arguments as the harness gets its port, and then quits; an error nothing
// caught is traced as "\x01swf2es:error <text>". What it uses is visible
// at every version, events by their strings, but uncaughtErrorEvents, of
// AIR 2.0, which a root of SWF 9, at AIR 1.0, does not see: it leaves its
// errors to AIR.
//
// The root's LoaderInfo is not there until its first frame has run, so
// errors are caught from frame 1's EXIT_FRAME on: one before, as in the
// document class's constructor, stops the run with AIR's dialog, and the
// job comes back incomplete, the error's text among its traces. The
// EXIT_FRAME listener is added again then, after those the SWF's
// constructor added, so that from frame 2 on the end, as the harness's,
// follows what they trace in its frame.
package {
  import flash.desktop.NativeApplication;
  import flash.display.DisplayObject;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.ErrorEvent;
  import flash.events.Event;
  import flash.events.InvokeEvent;

  public class Swf2esOracleRoot extends Sprite {
    /** Off the display list, it hears every frame's events still. */
    private static const ticker:Shape = new Shape();
    private static var frame:int = 0;
    /** The frames to run; unknown until the InvokeEvent comes. */
    private static var frames:int = -1;
    private static var quitting:int = 0;

    {
      trace("\x01swf2es:begin 0");
      NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, invoked);
      ticker.addEventListener("exitFrame", exitFrame);
    }

    private static function invoked(e:InvokeEvent):void {
      frames = Math.max(1, int(e.arguments[0]));
      endIf();
    }

    private static function exitFrame(_:Event):void {
      frame++;
      if (frame == 1) {
        catchErrors();
        ticker.removeEventListener("exitFrame", exitFrame);
        ticker.addEventListener("exitFrame", exitFrame);
      }

      endIf();
    }

    private static function catchErrors():void {
      try {
        var root:DisplayObject = NativeApplication.nativeApplication.openedWindows[0].stage.getChildAt(0);
        root.loaderInfo["uncaughtErrorEvents"].addEventListener("uncaughtError", uncaught);
      } catch (e:Error) {
        // Not there before AIR 2.0: a root of SWF 9 leaves its errors to AIR.
      }
    }

    private static function uncaught(e:Event):void {
      e.preventDefault();
      var error:* = e["error"];
      var text:String = error is Error ? Error(error).toString()
        : error is ErrorEvent ? ErrorEvent(error).text : String(error);
      trace("\x01swf2es:error " + text);
    }

    private static function endIf():void {
      if (frames < 0 || frame < frames) {
        return;
      }

      ticker.removeEventListener("exitFrame", exitFrame);
      trace("\x01swf2es:end 0");
      // adl drops the last traces before it quits: it quits two frames later.
      quitting = 2;
      ticker.addEventListener("enterFrame", quit);
    }

    private static function quit(_:Event):void {
      if (--quitting <= 0) {
        ticker.removeEventListener("enterFrame", quit);
        NativeApplication.nativeApplication.exit(0);
      }
    }
  }
}
