package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.ColorTransform;

  public class BlendLayerColors extends Sprite {
    private var clips:Array = [];
    private var extras:Array = [];

    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, 32, 24);
      g.endFill();
    }

    public function BlendLayerColors() {
      var colors:Array = [
        new ColorTransform(1, 1, 1, 0.5),
        new ColorTransform(1, 1, 1, 1, 128, 0, 128, 0),
        new ColorTransform(1, 1, 1, 0.5, 0, 0, 0, 64)
      ];
      for (var row:int = 0; row < 3; row++) {
        for (var kind:int = 0; kind < 4; kind++) {
          for (var mode:int = 0; mode < 2; mode++) {
            var p:Sprite = new Sprite();
            p.x = 10 + (kind * 2 + mode) * 70;
            p.y = 10 + row * 50;
            var alpha:Number = row == 1 ? 0.5 : 1;
            // Flash isolates a clip with children, even if its only child is off to one side.
            // A clip with only its own graphics keeps per-fill colour transforms.
            if (kind == 0 || kind == 3) {
              rect(p.graphics, 0xff0000, alpha, 0, 0);
              rect(p.graphics, 0x00ff00, alpha, 16, 12);
            } else {
              var r:Shape = new Shape();
              rect(r.graphics, 0xff0000, alpha, 0, 0);
              p.addChild(r);
              var g:Shape = kind == 1 ? r : new Shape();
              rect(g.graphics, 0x00ff00, alpha, 16, 12);
              if (kind == 2) {
                p.addChild(g);
              }
            }

            var extra:Shape = new Shape();
            rect(extra.graphics, 0x0000ff, 1, 52, 0);
            if (kind == 3) {
              p.addChild(extra);
            }

            p.blendMode = mode == 0 ? "normal" : "layer";
            p.transform.colorTransform = colors[row];
            addChild(p);
            clips.push(p);
            extras.push(extra);
          }
        }
      }

      var frame:int = 0;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        frame++;
        for (var i:int = 0; i < clips.length; i++) {
          var clip:Sprite = clips[i];
          var kind:int = int(i / 2) % 4;
          if (frame == 1 || frame == 2) {
            if (kind == 0) {
              if (frame == 1) {
                clip.addChild(extras[i]);
              } else {
                clip.removeChild(extras[i]);
              }
            } else if (kind == 3) {
              if (frame == 1) {
                clip.removeChild(extras[i]);
              } else {
                clip.addChild(extras[i]);
              }
            }

            if (i < 8) {
              clip.alpha = frame == 1 ? 0.25 : 0.75;
            }
          } else if (frame == 3 || frame == 4) {
            clip.blendMode = frame == 3 ? "normal" : (i % 2 == 0 ? "normal" : "layer");
          }
        }

        if (frame == 5) {
          transform.colorTransform = new ColorTransform(0.5, 1, 0.75, 0.5, 32, 0, 0, 0);
        }
      });
      trace("drawn");
    }
  }
}
