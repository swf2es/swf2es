// What a player costs the machine to keep a SWF going at 60 frames a
// second: a still stage, where nothing changes, and a light animation, a
// hundred shapes moving. Each runs for a while to settle, then marks the
// start and the end of the time measured, as they happen: players.ts adds
// up the CPU time of the player's processes between the two (a browser's
// page, GPU and other processes, or Wine's).
//
// Built only by players.ts, which puts playersReport, playersMark and
// playersFinish after it.
package {
import flash.display.DisplayObject;
import flash.display.Shape;
import flash.display.Sprite;
import flash.display.StageAlign;
import flash.display.StageScaleMode;
import flash.events.Event;
import flash.utils.getTimer;

public class Main extends Sprite {
  private static const WIDTH:int = 800;
  private static const HEIGHT:int = 600;
  private static const SETTLE_MS:int = 2000;
  private static const MEASURE_MS:int = 10000;
  private static const SCENES:Array = [["still", 1], ["light", 100]];

  private var _scene:int = -1;
  private var _layer:Sprite;
  private var _objects:Vector.<DisplayObject>;
  private var _frame:int = 0;
  private var _started:int = 0;
  private var _measuring:Boolean = false;

  public function Main() {
    stage.scaleMode = StageScaleMode.NO_SCALE;
    stage.align = StageAlign.TOP_LEFT;
    stage.frameRate = 60;
    next();
    addEventListener(Event.ENTER_FRAME, frame);
  }

  private function next():void {
    if (_layer) {
      removeChild(_layer);
    }

    _scene++;
    if (_scene >= SCENES.length) {
      removeEventListener(Event.ENTER_FRAME, frame);
      playersFinish();
      return;
    }

    _layer = new Sprite();
    addChild(_layer);
    _objects = new Vector.<DisplayObject>();
    var count:int = SCENES[_scene][1];
    for (var i:int = 0; i < count; i++) {
      var shape:Shape = new Shape();
      shape.graphics.beginFill(0x3060c0 + (i * 2654435761 & 0x3f3f3f));
      shape.graphics.drawRoundRect(-12, -8, 24, 16, 6, 6);
      shape.graphics.endFill();
      shape.x = 40 + (i * 37) % (WIDTH - 80);
      shape.y = 30 + (i * 53) % (HEIGHT - 60);
      _objects.push(shape);
      _layer.addChild(shape);
    }

    _frame = 0;
    _started = getTimer();
    _measuring = false;
  }

  private function frame(event:Event):void {
    var name:String = SCENES[_scene][0];
    if (name === "light") {
      for (var i:int = 0; i < _objects.length; i++) {
        var t:Number = _frame * 0.02 + i * 0.37;
        _objects[i].x = WIDTH / 2 + Math.cos(t * 1.3 + i) * (WIDTH / 2 - 40);
        _objects[i].y = HEIGHT / 2 + Math.sin(t * 0.9 + i * 0.5) * (HEIGHT / 2 - 30);
        _objects[i].rotation = (_frame * 2 + i * 7) % 360;
      }
    }

    _frame++;
    var now:int = getTimer();
    if (!_measuring && now - _started >= SETTLE_MS) {
      _measuring = true;
      playersMark("cpu: begin " + name);
    } else if (_measuring && now - _started >= SETTLE_MS + MEASURE_MS) {
      playersMark("cpu: end " + name);
      next();
    }
  }
}
}
