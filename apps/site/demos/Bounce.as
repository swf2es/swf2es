package {
  import flash.display.BlendMode;
  import flash.display.GradientType;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.KeyboardEvent;
  import flash.events.MouseEvent;
  import flash.filters.GlowFilter;
  import flash.geom.Matrix;
  import flash.system.Capabilities;
  import flash.text.TextField;
  import flash.text.TextFieldAutoSize;
  import flash.text.TextFormat;
  import flash.ui.Keyboard;
  import flash.utils.getTimer;

  // The site's ActionScript 3 demo: glowing balls that fall and bounce,
  // more where the stage is clicked, a pause on the space bar, and an
  // error thrown on E for the site's console to show. It traces as it goes.
  public class Bounce extends Sprite {
    private static const COLORS:Array = [0xff5a5f, 0xffb400, 0x2ec4b6, 0x3a86ff, 0xc77dff];

    private var _balls:Array = [];
    private var _info:TextField;
    private var _paused:Boolean = false;
    private var _clicks:int = 0;
    private var _frames:int = 0;
    private var _seed:uint = 7;

    public function Bounce() {
      trace("Hello from ActionScript 3, compiled to JavaScript by swf2es.");
      trace("Capabilities.version: " + Capabilities.version);
      if (stage) {
        init();
      } else {
        addEventListener(Event.ADDED_TO_STAGE, init);
      }
    }

    private function init(e:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, init);
      var w:Number = stage.stageWidth;
      var h:Number = stage.stageHeight;
      trace("Stage " + w + " x " + h + " at " + stage.frameRate + " fps");

      var back:Shape = new Shape();
      var m:Matrix = new Matrix();
      m.createGradientBox(w, h, Math.PI / 2);
      back.graphics.beginGradientFill(GradientType.LINEAR, [0x1b2a41, 0x0c1321], [1, 1], [0, 255], m);
      back.graphics.drawRect(0, 0, w, h);
      back.graphics.endFill();
      addChild(back);

      for (var i:int = 0; i < 12; i++) {
        addBall(40 + random() * (w - 80), 40 + random() * (h / 2));
      }

      _info = new TextField();
      _info.defaultTextFormat = new TextFormat("_sans", 13, 0xffffff);
      _info.autoSize = TextFieldAutoSize.LEFT;
      _info.selectable = false;
      _info.x = 8;
      _info.y = 6;
      addChild(_info);

      stage.addEventListener(MouseEvent.MOUSE_DOWN, onDown);
      stage.addEventListener(KeyboardEvent.KEY_DOWN, onKey);
      addEventListener(Event.ENTER_FRAME, onFrame);
      trace("Click to add balls, press space to pause, E to throw an error.");
    }

    /** A small LCG, so every run starts the same. */
    private function random():Number {
      _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
      return _seed / 0x7fffffff;
    }

    private function addBall(x:Number, y:Number):void {
      var r:Number = 10 + random() * 16;
      var color:uint = COLORS[_balls.length % COLORS.length];
      var s:Shape = new Shape();
      var m:Matrix = new Matrix();
      m.createGradientBox(r * 2, r * 2, 0, -r * 1.3, -r * 1.3);
      s.graphics.beginGradientFill(GradientType.RADIAL, [0xffffff, color], [1, 1], [0, 200], m);
      s.graphics.drawCircle(0, 0, r);
      s.graphics.endFill();
      s.filters = [new GlowFilter(color, 0.8, 16, 16, 2)];
      s.blendMode = BlendMode.ADD;
      s.x = x;
      s.y = y;
      addChildAt(s, Math.min(numChildren, 1 + _balls.length));
      _balls.push({ shape: s, r: r, vx: (random() - 0.5) * 8, vy: (random() - 0.5) * 4 });
    }

    private function onDown(e:MouseEvent):void {
      _clicks++;
      for (var i:int = 0; i < 5; i++) {
        addBall(e.stageX, e.stageY);
      }

      trace("Click " + _clicks + " at (" + Math.round(e.stageX) + ", " + Math.round(e.stageY) +
        "): " + _balls.length + " balls");
    }

    private function onKey(e:KeyboardEvent):void {
      if (e.keyCode == Keyboard.SPACE) {
        _paused = !_paused;
        trace(_paused ? "Paused" : "Playing");
      } else if (e.keyCode == 69) {
        trace("Throwing an error, as asked");
        throw new Error("An error thrown on purpose by the demo");
      }
    }

    private function onFrame(e:Event):void {
      _frames++;
      var w:Number = stage.stageWidth;
      var h:Number = stage.stageHeight;
      if (!_paused) {
        for each (var b:Object in _balls) {
          var s:Shape = b.shape;
          b.vy += 0.35;
          s.x += b.vx;
          s.y += b.vy;
          if (s.x < b.r) {
            s.x = b.r;
            b.vx = -b.vx;
          } else if (s.x > w - b.r) {
            s.x = w - b.r;
            b.vx = -b.vx;
          }

          if (s.y > h - b.r) {
            s.y = h - b.r;
            b.vy = -b.vy * 0.92;
            if (Math.abs(b.vy) < 2) {
              // Kicked up again, so the demo never settles.
              b.vy = -10 - random() * 6;
            }
          }
        }
      }

      if (_frames % 10 == 1) {
        _info.text = "swf2es | ActionScript 3 | " + _balls.length + " balls | frame " + _frames +
          " | " + Math.round(getTimer() / 1000) + " s" + (_paused ? " | paused" : "");
      }

      if (_frames % 300 == 0) {
        trace("Frame " + _frames + ", " + _balls.length + " balls");
      }
    }
  }
}
