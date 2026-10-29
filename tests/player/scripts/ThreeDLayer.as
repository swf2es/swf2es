package {
  import flash.display.*;

  // A 3D object, at a z of 0 and unturned, with a layer blend under alpha:
  // Flash draws its colour into its bitmap, each child's on its own, so
  // where they overlap both show, and composites the bitmap once.
  public class ThreeDLayer extends Sprite {
    private function rect(g:Graphics, color:uint, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    public function ThreeDLayer() {
      rect(graphics, 0xffffff, 0, 0, 320, 160);

      var layered:Sprite = new Sprite();
      var a:Shape = new Shape();
      rect(a.graphics, 0xcc3333, 0, 0, 60, 60);
      var b:Shape = new Shape();
      rect(b.graphics, 0x3333cc, 30, 30, 60, 60);
      layered.addChild(a);
      layered.addChild(b);
      layered.x = 30;
      layered.y = 30;
      layered.z = 0;
      layered.blendMode = "layer";
      layered.alpha = 0.5;
      addChild(layered);

      trace("drawn");
    }
  }
}
