package {
  import flash.display.*;
  import flash.events.Event;

  // Blends that read what is behind moved by parts of a pixel, frame after frame: overlapping
  // rectangles whose edges, axis-aligned, fall between pixels, over a striped ground. The player
  // keeps a blend's layer while its object only moves; one moved by part of a pixel must be drawn
  // where it is, not where its layer's pixels last fell. A moves 0.3 across a frame, B 0.25 down,
  // D 1 across (whole pixels), and C stands between pixels. (Moved 0.45 down, or 0.7 both ways,
  // the edges come out of Flash's rasterizer up to 50 levels from the player's, drawn afresh or
  // kept alike.)
  public class BlendSubpixel extends Sprite {
    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    private function layer(mode:String, x:Number, y:Number):Sprite {
      var s:Sprite = new Sprite();
      var back:Shape = new Shape();
      rect(back.graphics, 0xe08030, 0.9, 0, 0, 26, 20);
      s.addChild(back);
      var front:Shape = new Shape();
      rect(front.graphics, 0x3070d0, 0.7, 8.5, 6.5, 22, 18);
      s.addChild(front);
      s.blendMode = mode;
      s.x = x;
      s.y = y;
      addChild(s);
      return s;
    }

    public function BlendSubpixel() {
      for (var i:int = 0; i < 24; i++) {
        graphics.beginFill(i % 2 ? 0x406080 : 0xa07040);
        graphics.drawRect(i * 10, 0, 10, 100);
      }
      graphics.beginFill(0xd0d0c0);
      graphics.drawRect(0, 45, 240, 12);
      graphics.endFill();

      var a:Sprite = layer("overlay", 10.25, 10);
      var b:Sprite = layer("hardlight", 70, 8.5);
      var c:Sprite = layer("difference", 130.5, 20.5);
      var d:Sprite = layer("overlay", 180, 50);

      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        a.x += 0.3;
        b.y += 0.25;
        d.x += 1;
      });
      trace("drawn");
    }
  }
}
