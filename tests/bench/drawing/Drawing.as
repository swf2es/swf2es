// Drawing at a load: each scene with fewer and more objects, moved every
// frame at 60 frames a second, and the frames' intervals by getTimer. A
// player that keeps up shows 60 and intervals of 16 or 17 ms; one that
// cannot shows fewer frames and longer intervals. Under load each player
// plays a frame each time it draws, so the frames counted are frames
// drawn; a faster frame rate than the display's would count frames some
// players run without drawing.
//
// Built only by players.ts, which puts playersReport and playersFinish
// after it. Each level reports a line:
//   frames: vectors-500 fps 59.9 p50 17 p95 17 p99 18 max 33 total 41943040 private 0
// total and private are System.totalMemoryNumber and System.privateMemory,
// 0 in a player that does not keep them.
package {
import flash.display.Bitmap;
import flash.display.BitmapData;
import flash.display.DisplayObject;
import flash.display.Shape;
import flash.display.Sprite;
import flash.display.StageAlign;
import flash.display.StageScaleMode;
import flash.events.Event;
import flash.filters.BlurFilter;
import flash.filters.GlowFilter;
import flash.system.System;
import flash.text.TextField;
import flash.text.TextFormat;
import flash.utils.getTimer;

public class Main extends Sprite {
  private static const WIDTH:int = 800;
  private static const HEIGHT:int = 600;
  // A level settles for this long before its frames are timed, and is timed for this long.
  private static const SETTLE_MS:int = 1000;
  private static const MEASURE_MS:int = 5000;
  private static const LEVELS:Array = [
    ["vectors", [500, 2000, 8000]],
    ["bitmaps", [500, 2000, 8000]],
    ["filters", [25, 100, 400]],
    ["text", [50, 200, 800]],
    ["redraw", [50, 200, 800]],
  ];

  private var _scene:int = 0;
  private var _level:int = -1;
  private var _layer:Sprite;
  private var _objects:Vector.<DisplayObject>;
  private var _frame:int = 0;
  private var _started:int = 0;
  private var _last:int = 0;
  private var _intervals:Vector.<int>;
  private var _texture:BitmapData;

  public function Main() {
    stage.scaleMode = StageScaleMode.NO_SCALE;
    stage.align = StageAlign.TOP_LEFT;
    stage.frameRate = 60;
    _texture = texture();
    next();
    addEventListener(Event.ENTER_FRAME, frame);
  }

  /** A 64 by 64 checker of four colours with a soft edge, for the bitmaps to smooth. */
  private static function texture():BitmapData {
    var bitmap:BitmapData = new BitmapData(64, 64, true, 0);
    var colours:Array = [0xffe04040, 0xff40a0e0, 0xff60c060, 0xffe0c040];
    for (var y:int = 0; y < 64; y++) {
      for (var x:int = 0; x < 64; x++) {
        var edge:int = Math.min(Math.min(x, 63 - x), Math.min(y, 63 - y));
        var alpha:uint = edge >= 4 ? 0xff : edge * 64;
        var colour:uint = colours[((x >> 4) + (y >> 4)) & 3];
        bitmap.setPixel32(x, y, (alpha << 24) | (colour & 0xffffff));
      }
    }

    return bitmap;
  }

  /** The next level, or the next scene's first; the report once there is none. */
  private function next():void {
    if (_layer) {
      removeChild(_layer);
    }

    _level++;
    if (_level >= LEVELS[_scene][1].length) {
      _scene++;
      _level = 0;
    }

    if (_scene >= LEVELS.length) {
      removeEventListener(Event.ENTER_FRAME, frame);
      playersFinish();
      return;
    }

    _layer = new Sprite();
    addChild(_layer);
    _objects = new Vector.<DisplayObject>();
    var count:int = LEVELS[_scene][1][_level];
    for (var i:int = 0; i < count; i++) {
      var object:DisplayObject = make(LEVELS[_scene][0], i);
      _objects.push(object);
      _layer.addChild(object);
    }

    _frame = 0;
    _started = getTimer();
    _last = -1;
    _intervals = new Vector.<int>();
  }

  private function make(scene:String, i:int):DisplayObject {
    var shape:Shape;
    switch (scene) {
      case "vectors":
      case "filters":
        shape = new Shape();
        shape.graphics.lineStyle(1, 0x202020);
        shape.graphics.beginFill(0x3060c0 + (i * 2654435761 & 0x3f3f3f));
        shape.graphics.drawRoundRect(-12, -8, 24, 16, 6, 6);
        shape.graphics.endFill();
        shape.graphics.beginFill(0xffffff, 0.6);
        shape.graphics.drawCircle(0, 0, 5);
        shape.graphics.endFill();
        if (scene === "filters") {
          shape.scaleX = shape.scaleY = 2;
          shape.filters = [new BlurFilter(4, 4, 2), new GlowFilter(0xffff00, 1, 8, 8, 2, 2)];
        }

        return shape;
      case "bitmaps":
        var bitmap:Bitmap = new Bitmap(_texture, "auto", true);
        bitmap.x = -32;
        bitmap.y = -32;
        var holder:Sprite = new Sprite();
        holder.addChild(bitmap);
        return holder;
      case "text":
        var field:TextField = new TextField();
        field.defaultTextFormat = new TextFormat("_sans", 12, 0x000000);
        field.width = 90;
        field.height = 20;
        field.text = "text " + i;
        return field;
      case "redraw":
        return new Shape();
    }

    return null;
  }

  private function frame(event:Event):void {
    var now:int = getTimer();
    var scene:String = LEVELS[_scene][0];
    var count:int = _objects.length;
    for (var i:int = 0; i < count; i++) {
      move(scene, _objects[i], i, _frame);
    }

    _frame++;
    if (now - _started < SETTLE_MS) {
      return;
    }

    if (_last >= 0) {
      _intervals.push(now - _last);
    }

    _last = now;
    if (now - _started >= SETTLE_MS + MEASURE_MS) {
      report(scene + "-" + count);
      next();
    }
  }

  /** Where each object is in a frame: across the stage on its own path, turning. */
  private function move(scene:String, object:DisplayObject, i:int, frame:int):void {
    var t:Number = frame * 0.02 + i * 0.37;
    object.x = WIDTH / 2 + Math.cos(t * 1.3 + i) * (WIDTH / 2 - 40);
    object.y = HEIGHT / 2 + Math.sin(t * 0.9 + i * 0.5) * (HEIGHT / 2 - 30);
    switch (scene) {
      case "vectors":
      case "bitmaps":
      case "filters":
        object.rotation = (frame * 2 + i * 7) % 360;
        if (scene === "bitmaps") {
          object.scaleX = object.scaleY = 0.5 + 0.25 * Math.sin(t);
        }

        break;
      case "text":
        TextField(object).text = "text " + i + " " + frame;
        break;
      case "redraw":
        var g:Shape = Shape(object);
        g.graphics.clear();
        g.graphics.lineStyle(2, 0x204080);
        g.graphics.beginFill(0x80c0ff, 0.5);
        g.graphics.moveTo(-20, 0);
        g.graphics.curveTo(0, -30 * Math.sin(t), 20, 0);
        g.graphics.curveTo(0, 30 * Math.cos(t), -20, 0);
        g.graphics.endFill();
        break;
    }
  }

  private function report(level:String):void {
    var sorted:Vector.<int> = _intervals.concat();
    sorted.sort(function(a:int, b:int):Number {
      return a - b;
    });
    var n:int = sorted.length;
    var total:int = 0;
    for (var i:int = 0; i < n; i++) {
      total += sorted[i];
    }

    var fps:Number = n > 0 && total > 0 ? Math.round(n * 10000 / total) / 10 : 0;
    playersReport(
      "frames: " + level,
      "fps", fps,
      "p50", percentile(sorted, 0.5),
      "p95", percentile(sorted, 0.95),
      "p99", percentile(sorted, 0.99),
      "max", n > 0 ? sorted[n - 1] : 0,
      "total", System.totalMemoryNumber,
      "private", System.privateMemory
    );
  }

  private static function percentile(sorted:Vector.<int>, p:Number):int {
    if (sorted.length === 0) {
      return 0;
    }

    return sorted[Math.min(sorted.length - 1, int(Math.floor(p * sorted.length)))];
  }
}
}
