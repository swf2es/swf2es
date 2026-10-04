package {
  import flash.display.*;
  import flash.geom.Rectangle;

  // Blended objects at the edges of what they are drawn over, over a ground
  // of stripes: partly past the stage's top-left and bottom-right corners,
  // past one edge each, wholly beyond either corner, a blend in a layer
  // that is itself partly past the top-left corner, and blends in a layer
  // cut by a scrollRect, reaching past it or wholly beyond it, which asked
  // the renderer for a copy of what is behind them with a size below zero.
  // Opaque colours whose difference, sum and subtraction are exact, so the
  // stage is drawn as Flash draws it.
  public class BlendEdges extends Sprite {
    private function rect(g:Graphics, color:uint, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    private function blended(mode:String, color:uint, x:Number, y:Number, w:Number, h:Number):Sprite {
      var s:Sprite = new Sprite();
      rect(s.graphics, color, 0, 0, w, h);
      s.x = x;
      s.y = y;
      s.blendMode = mode;
      return s;
    }

    public function BlendEdges() {
      var ground:Shape = new Shape();
      for (var i:int = 0; i < 10; i++) {
        rect(ground.graphics, i % 2 ? 0x204060 : 0xc08040, i * 20, 0, 20, 150);
      }
      addChild(ground);

      addChild(blended("difference", 0xffffff, -30, -20, 80, 60));
      addChild(blended("difference", 0x00ff00, 160, 110, 80, 60));
      addChild(blended("add", 0x404040, 120, -25, 40, 50));
      addChild(blended("subtract", 0x606060, 185, 40, 40, 30));
      addChild(blended("difference", 0xffffff, -120, -90, 60, 40));
      addChild(blended("add", 0xffffff, 230, 170, 60, 40));

      var layer:Sprite = new Sprite();
      rect(layer.graphics, 0x3060c0, 0, 0, 50, 40);
      layer.x = -10;
      layer.y = 100;
      layer.blendMode = "layer";
      layer.addChild(blended("difference", 0xffff00, -20, 20, 40, 40));
      addChild(layer);

      // A layer cut by its scrollRect, whose blended children reach past
      // its edges or lie wholly beyond them: what is behind them is the
      // layer's, which ends at its edges.
      var panel:Sprite = new Sprite();
      rect(panel.graphics, 0x3060c0, 0, 0, 60, 50);
      panel.x = 70;
      panel.y = 50;
      panel.scrollRect = new Rectangle(0, 0, 60, 50);
      panel.blendMode = "layer";
      panel.addChild(blended("difference", 0xffffff, -10, -10, 30, 30));
      panel.addChild(blended("difference", 0x00ffff, 45, 35, 30, 30));
      panel.addChild(blended("add", 0xffffff, 10, -30, 20, 10));
      panel.addChild(blended("add", 0xffffff, -40, 10, 20, 20));
      panel.addChild(blended("subtract", 0xffffff, 70, 60, 20, 20));
      addChild(panel);
      trace("drawn");
    }
  }
}
