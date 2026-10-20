package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.Matrix;

  public class HiddenStrokes extends Sprite {
    private var frames:int = 0;
    private var hidden:Sprite = new Sprite();
    private var nested:Sprite = new Sprite();
    private var shape:Shape = new Shape();
    private var maskParent:Sprite = new Sprite();
    private var clip:Sprite = new Sprite();
    private var clipShape:Shape = new Shape();

    public function HiddenStrokes() {
      addChild(hidden);
      hidden.addChild(nested);
      nested.addChild(shape);
      hidden.visible = false;
      paint(0x00a040);

      var target:Shape = new Shape();
      target.graphics.beginFill(0x3060ff);
      target.graphics.drawRect(180, 10, 100, 80);
      addChild(target);
      addChild(maskParent);
      maskParent.addChild(clip);
      clip.visible = false;
      clip.addChild(clipShape);
      clipShape.visible = false;
      clipShape.graphics.lineStyle(8, 0);
      clipShape.graphics.beginFill(0);
      clipShape.graphics.drawRect(180, 10, 30, 40);
      target.mask = clip;
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function paint(color:uint):void {
      shape.graphics.clear();
      shape.graphics.lineStyle(4, 0x202020, 1, false, "normal", "square", "miter", 3);
      shape.graphics.beginFill(color);
      shape.graphics.drawRect(4, 4, 20, 16);
    }

    private function step(event:Event):void {
      frames++;
      switch (frames) {
        case 1:
          shape.scaleX = shape.scaleY = 2;
          break;
        case 2:
          shape.scaleX = shape.scaleY = 3;
          paint(0xff8030);
          clipShape.x = 20;
          break;
        case 3:
          // Draw the hidden branch's child at its current stage scale.
          var pixels:BitmapData = new BitmapData(90, 80, false, 0xffffff);
          pixels.draw(shape, new Matrix(3, 0, 0, 3));
          var bitmap:Bitmap = new Bitmap(pixels);
          bitmap.x = 90;
          addChild(bitmap);
          trace("draw", pixels.getPixel(12, 12), pixels.getPixel(30, 30));
          break;
        case 4:
          // Neither the child nor its intermediate parent changes this frame.
          hidden.visible = true;
          break;
        case 5:
          hidden.visible = false;
          shape.scaleX = shape.scaleY = 2;
          break;
        case 6:
          // Reparenting must also make the deferred lines current.
          addChild(shape);
          shape.y = 90;
          break;
      }
    }
  }
}
