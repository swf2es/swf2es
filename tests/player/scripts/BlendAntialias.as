package {
  import flash.display.*;
  import flash.filters.BlurFilter;

  // Blends nested in blends, a blurred child in a blended layer and blends
  // past the stage's edges, over a ground of stripes, for a renderer that
  // multisamples: each blend reads what is behind it from a multisampled
  // target, the stage's or a layer's, and only the part it covers is
  // resolved for it. Opaque colours, axis-aligned shapes on whole pixels
  // and blurs of whole pixels, so multisampling changes no edge.
  public class BlendAntialias extends Sprite {
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

    private function blurred(color:uint, x:Number, y:Number, w:Number, h:Number, blur:Number):Sprite {
      var s:Sprite = new Sprite();
      rect(s.graphics, color, 0, 0, w, h);
      s.x = x;
      s.y = y;
      s.filters = [new BlurFilter(blur, blur, 1)];
      return s;
    }

    public function BlendAntialias() {
      var ground:Shape = new Shape();
      for (var i:int = 0; i < 12; i++) {
        rect(ground.graphics, i % 2 ? 0x3070b0 : 0xd09050, i * 20, 0, 20, 160);
      }
      for (var j:int = 0; j < 4; j++) {
        rect(ground.graphics, 0x205020, 0, j * 40 + 16, 240, 8);
      }
      addChild(ground);

      // Multiply holding screen holding overlay, and an add reaching past it.
      var outer:Sprite = blended("multiply", 0xc0c0ff, 20, 20, 90, 60);
      var screen:Sprite = blended("screen", 0x604000, 10, 10, 60, 40);
      screen.addChild(blended("overlay", 0x80ff40, 20, 10, 50, 40));
      outer.addChild(screen);
      outer.addChild(blended("add", 0x203040, 50, 30, 50, 40));
      addChild(outer);

      // A blurred child in a screen layer, its glow past the layer's shape.
      var glow:Sprite = blended("screen", 0x202020, 130, 20, 70, 50);
      glow.addChild(blurred(0xff4000, 20, 15, 30, 20, 8));
      addChild(glow);

      // Past the left and bottom edges, the top-right corner and the
      // bottom-right one, the last blurred in an add layer.
      addChild(blended("difference", 0xffffff, -20, 120, 60, 60));
      var corner:Sprite = blended("overlay", 0x40c0ff, 200, -15, 60, 50);
      corner.addChild(blended("multiply", 0xff8080, 20, 20, 40, 40));
      addChild(corner);
      var edge:Sprite = blended("add", 0x404040, 200, 120, 60, 60);
      edge.addChild(blurred(0x00c060, 10, 10, 30, 20, 4));
      addChild(edge);
      trace("drawn");
    }
  }
}
