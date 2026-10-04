package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.geom.Point;
  import flash.ui.Mouse;
  import flash.ui.MouseCursor;
  import flash.ui.MouseCursorData;

  public class MouseCursorNatives extends Sprite {
    public function MouseCursorNatives() {
      trace("supportsCursor " + Mouse.supportsCursor);
      trace("supportsNativeCursor " + Mouse.supportsNativeCursor);
      trace("cursor " + Mouse.cursor);
      for each (var name:* in [MouseCursor.ARROW, MouseCursor.BUTTON, MouseCursor.HAND,
          MouseCursor.IBEAM, MouseCursor.AUTO, "ARROW", "", "none", null, undefined, 5]) {
        attempt("cursor = " + name, function():* {
          Mouse.cursor = name;
          return Mouse.cursor;
        });
      }

      // A refused name leaves the one before it.
      Mouse.cursor = MouseCursor.IBEAM;
      attempt("cursor = bogus", function():* {
        Mouse.cursor = "bogus";
      });
      trace("cursor " + Mouse.cursor);
      Mouse.hide();
      Mouse.cursor = MouseCursor.BUTTON;
      trace("hidden, cursor " + Mouse.cursor);
      Mouse.show();
      Mouse.cursor = MouseCursor.AUTO;

      var d:MouseCursorData = new MouseCursorData();
      trace("data " + d.data + ", hotSpot " + d.hotSpot + ", frameRate " + d.frameRate);
      var p:Point = new Point(3, 4);
      d.hotSpot = p;
      p.x = 9;
      trace("hotSpot " + d.hotSpot + ", same " + (d.hotSpot == d.hotSpot));
      d.hotSpot = new Point(1.5, -2);
      trace("hotSpot " + d.hotSpot);
      attempt("hotSpot = null", function():* {
        d.hotSpot = null;
      });
      for each (var rate:Number in [10, 0.5, -1, -Infinity, NaN, Infinity]) {
        d.frameRate = rate;
        trace("frameRate = " + rate + ": " + d.frameRate);
      }

      var frames:Vector.<BitmapData> = frameList(bitmap(16, 16));
      d.data = frames;
      trace("data same " + (d.data == frames) + ", length " + d.data.length);
      frames.push(bitmap(8, 8));
      trace("data length after push " + d.data.length);
      d.data = null;
      trace("data " + d.data);

      // Refusals, in the order Flash checks them.
      attempt("register null, null", function():* {
        Mouse.registerCursor(null, null);
      });
      attempt("register null name", function():* {
        Mouse.registerCursor(null, new MouseCursorData());
      });
      attempt("register no data", function():* {
        Mouse.registerCursor("none", cursorData(null, new Point(50, 0)));
        Mouse.cursor = "none";
      });
      attempt("register empty data", function():* {
        Mouse.registerCursor("empty", cursorData(frameList(), new Point(50, 0)));
      });
      attempt("register hot spot -0.5", function():* {
        Mouse.registerCursor("x", cursorData(frameList(bitmap(16, 16)), new Point(-0.5, 0)));
      });
      attempt("register hot spot 31.01", function():* {
        Mouse.registerCursor("x", cursorData(frameList(bitmap(16, 16)), new Point(0, 31.01)));
      });
      attempt("register hot spot past a 40 bitmap", function():* {
        Mouse.registerCursor("x", cursorData(frameList(bitmap(40, 40)), new Point(50, 50)));
      });
      attempt("register a null frame", function():* {
        Mouse.registerCursor("x", cursorData(frameList(bitmap(16, 16), null)));
      });
      attempt("register 33 wide", function():* {
        Mouse.registerCursor("x", cursorData(frameList(bitmap(33, 1))));
      });
      attempt("register 33 high second", function():* {
        Mouse.registerCursor("x", cursorData(frameList(bitmap(16, 16), bitmap(1, 33))));
      });
      var gone:BitmapData = bitmap(40, 40);
      gone.dispose();
      attempt("register a disposed frame", function():* {
        Mouse.registerCursor("x", cursorData(frameList(bitmap(16, 16), gone)));
      });
      attempt("cursor = x", function():* {
        Mouse.cursor = "x";
      });

      // Accepted: 32 a side, a hot spot past a smaller frame, frames of any size and rate.
      attempt("register mine", function():* {
        Mouse.registerCursor("mine", cursorData(frameList(bitmap(32, 32), bitmap(8, 8)),
            new Point(31, 10), NaN));
        return Mouse.cursor;
      });
      attempt("cursor = mine", function():* {
        Mouse.cursor = "mine";
        return Mouse.cursor;
      });
      attempt("register mine again with no data", function():* {
        Mouse.registerCursor("mine", new MouseCursorData());
        Mouse.cursor = MouseCursor.AUTO;
        Mouse.cursor = "mine";
        return Mouse.cursor;
      });
      attempt("unregister other", function():* {
        Mouse.unregisterCursor("other");
        return Mouse.cursor;
      });
      attempt("unregister null", function():* {
        Mouse.unregisterCursor(null);
      });
      attempt("unregister mine", function():* {
        Mouse.unregisterCursor("mine");
        return Mouse.cursor;
      });
      attempt("cursor = mine", function():* {
        Mouse.cursor = "mine";
      });

      // A registered name shadows Flash's own: unregistering it while shown is back to auto.
      attempt("register arrow", function():* {
        Mouse.registerCursor(MouseCursor.ARROW, cursorData(frameList(bitmap(16, 16))));
        Mouse.cursor = MouseCursor.ARROW;
        Mouse.unregisterCursor(MouseCursor.ARROW);
        return Mouse.cursor;
      });
      Mouse.cursor = MouseCursor.BUTTON;
      attempt("unregister button, never registered", function():* {
        Mouse.unregisterCursor(MouseCursor.BUTTON);
        return Mouse.cursor;
      });
      Mouse.cursor = MouseCursor.AUTO;
    }

    private function attempt(label:String, f:Function):void {
      try {
        var result:* = f();
        trace(label + (result === undefined ? "" : ": " + result));
      } catch (e:Error) {
        trace(label + " threw " + e);
      }
    }

    private function bitmap(width:int, height:int):BitmapData {
      return new BitmapData(width, height, true, 0xff3366cc);
    }

    private function frameList(... bitmaps):Vector.<BitmapData> {
      var v:Vector.<BitmapData> = new Vector.<BitmapData>();
      for each (var b:* in bitmaps) {
        v.push(b);
      }

      return v;
    }

    private function cursorData(frames:Vector.<BitmapData>, hotSpot:Point = null,
        frameRate:Number = 0):MouseCursorData {
      var d:MouseCursorData = new MouseCursorData();
      d.data = frames;
      if (hotSpot) {
        d.hotSpot = hotSpot;
      }

      d.frameRate = frameRate;
      return d;
    }
  }
}
