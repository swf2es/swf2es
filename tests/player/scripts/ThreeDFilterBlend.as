package {
  import flash.display.BlendMode;
  import flash.display.Sprite;
  import flash.filters.DropShadowFilter;
  import flash.filters.GlowFilter;

  // 3D cards with filters and a blend mode over a background: Flash filters
  // the card in its bitmap, then blends what is drawn through its plane with
  // what is behind it.
  public class ThreeDFilterBlend extends Sprite {
    public function ThreeDFilterBlend() {
      graphics.beginFill(0x88cc88);
      graphics.drawRect(0, 0, 500, 200);
      graphics.endFill();
      graphics.beginFill(0x4040a0);
      graphics.drawRect(0, 200, 500, 200);
      graphics.endFill();
      var modes:Array = [
        BlendMode.NORMAL,
        BlendMode.MULTIPLY,
        BlendMode.ADD,
        BlendMode.SCREEN,
        BlendMode.SUBTRACT,
        BlendMode.OVERLAY,
      ];
      for (var row:int = 0; row < 2; row++) {
        for (var i:int = 0; i < modes.length; i++) {
          var s:Sprite = new Sprite();
          s.graphics.beginFill(0xcc6633);
          s.graphics.drawRect(-25, -40, 50, 80);
          s.graphics.beginFill(0xffffff);
          s.graphics.drawRect(-15, -30, 15, 15);
          s.graphics.endFill();
          s.x = 45 + i * 82;
          s.y = 100 + row * 200;
          s.rotationY = 35;
          s.filters = row == 0
            ? [new GlowFilter(0xffff00, 1, 10, 10, 2)]
            : [new DropShadowFilter(6, 45, 0x000000, 0.8, 4, 4)];
          s.blendMode = modes[i];
          addChild(s);
        }
      }
      trace(numChildren);
    }
  }
}
