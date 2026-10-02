package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.*;

  // Colour transforms as adl draws them: per shape, on straight colour,
  // clamped; an alpha offset over an alpha-0 fill and a transparent bitmap;
  // multipliers past 1 and below 0; nesting; a gradient and a line.
  public class ColorTransforms extends Sprite {
    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    public function ColorTransforms() {
      // Row 0: colour transforms, each cell 100 wide, over a black left half and a white right half.
      for (var i:int = 0; i < 6; i++) {
        rect(graphics, 0x000000, 1, i * 100, 0, 50, 100);
        rect(graphics, 0xffffff, 1, i * 100 + 50, 0, 50, 100);
      }

      // 0: a sprite of two overlapping half-alpha reds, its transform halving red, adding green 128, halving alpha.
      var a:Sprite = new Sprite();
      rect(a.graphics, 0xff0000, 0.5, 10, 10, 50, 50);
      rect(a.graphics, 0xff0000, 0.5, 40, 40, 50, 50);
      var aa:Shape = new Shape();
      rect(aa.graphics, 0x0000ff, 1, 25, 70, 50, 20);
      a.addChild(aa);
      a.transform.colorTransform = new ColorTransform(0.5, 1, 1, 0.5, 0, 128, 0, 0);
      addChild(a);

      // 1: half-alpha red plus green 255: offsets before or after alpha?
      var b:Shape = new Shape();
      rect(b.graphics, 0xff0000, 0.5, 110, 10, 80, 80);
      b.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 0, 255, 0, 0);
      addChild(b);

      // 2: a fill of alpha 0 with alpha offset 255, and a transparent bitmap with alpha offset 128.
      var c:Shape = new Shape();
      rect(c.graphics, 0xff0000, 0, 210, 10, 80, 35);
      c.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 0, 0, 0, 255);
      addChild(c);
      var data:BitmapData = new BitmapData(80, 35, true, 0x0000ff00);
      data.fillRect(new Rectangle(0, 0, 40, 35), 0x800000ff);
      var bm:Bitmap = new Bitmap(data);
      bm.x = 210;
      bm.y = 55;
      bm.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 0, 0, 0, 128);
      addChild(bm);

      // 3: multipliers past 1 and negative: red 2x on dark red, and an inversion.
      var d:Shape = new Shape();
      rect(d.graphics, 0x602040, 1, 310, 10, 80, 35);
      d.transform.colorTransform = new ColorTransform(2, 3, -1, 1, 0, 0, 255, 0);
      addChild(d);
      var d2:Shape = new Shape();
      rect(d2.graphics, 0x3080c0, 1, 310, 55, 80, 35);
      d2.transform.colorTransform = new ColorTransform(-1, -1, -1, 1, 255, 255, 255, 0);
      addChild(d2);

      // 4: nested transforms: parent adds red 100, child multiplies by 0.5.
      var p:Sprite = new Sprite();
      var q:Shape = new Shape();
      rect(q.graphics, 0x408020, 1, 410, 10, 80, 80);
      p.addChild(q);
      p.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 100, 0, 0, 0);
      q.transform.colorTransform = new ColorTransform(0.5, 0.5, 0.5, 1, 0, 0, 0, 0);
      addChild(p);

      // 5: a gradient and a line under an offset.
      var e:Shape = new Shape();
      var m:Matrix = new Matrix();
      m.createGradientBox(80, 40, 0, 510, 10);
      e.graphics.beginGradientFill(GradientType.LINEAR, [0x000000, 0xffffff], [1, 0.2], [0, 255], m);
      e.graphics.drawRect(510, 10, 80, 40);
      e.graphics.endFill();
      e.graphics.lineStyle(6, 0x204060);
      e.graphics.moveTo(515, 70);
      e.graphics.lineTo(585, 70);
      // No transformed stop clamps: where one does, Flash clamps before the
      // ramp and swf2es after, which is documented, not drawn here.
      e.transform.colorTransform = new ColorTransform(0.5, 0.5, 1, 1, 64, 32, 0, 0);
      addChild(e);
      trace("drawn");

      // Changed as it plays: another offset (the vertices packed again), then
      // a plain multiplier and back to an offset (Pixi's tint, then the batcher again).
      var frame:int = 1;
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        frame++;
        if (frame == 2) {
          b.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 0, 0, 255, 0);
          d2.transform.colorTransform = new ColorTransform(0.5, 1, 0.25, 1, 0, 0, 0, 0);
        } else if (frame == 3) {
          b.transform.colorTransform = new ColorTransform(0.5, 1, 1, 0.5, 0, 0, 0, 0);
          d2.transform.colorTransform = new ColorTransform(1, 1, 1, 1, -100, 0, 0, 0);
        }
      });
    }
  }
}
