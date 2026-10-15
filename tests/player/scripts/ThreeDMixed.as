package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.BlendMode;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.geom.ColorTransform;
  import flash.geom.Rectangle;

  // 3D cards under what Flash draws them by, apart from their plane: an
  // ancestor's alpha and colour, which go into each of the card's fills,
  // their own, a scrollRect, which Flash ignores in 3D, cacheAsBitmap, blend
  // modes, which composite the drawn card with what is behind it, a blend
  // in a card, and a BitmapData's draw of a card on no stage, which
  // projects as on a stage the bitmap's size.
  public class ThreeDMixed extends Sprite {
    public function ThreeDMixed() {
      // A background for the blend modes.
      graphics.beginFill(0x88cc88);
      graphics.drawRect(0, 200, 500, 200);
      graphics.endFill();

      // Ancestors' alpha and colour offset.
      var faded:Sprite = new Sprite();
      faded.alpha = 0.5;
      addChild(faded);
      faded.addChild(turned(card(0x3355aa), 60, 60));
      var tinted:Sprite = new Sprite();
      tinted.transform.colorTransform = new ColorTransform(0.5, 1, 1, 1, 120, 0, 0, 0);
      addChild(tinted);
      tinted.addChild(turned(card(0x3355aa), 160, 60));
      // Its own alpha and colour offset.
      var own:Sprite = turned(card(0x3355aa), 260, 60);
      own.transform.colorTransform = new ColorTransform(1, 1, 1, 0.5, 0, 100, 0, 0);
      addChild(own);
      // scrollRect on a 3D card.
      var scrolled:Sprite = turned(card(0xaa5533), 360, 60);
      scrolled.scrollRect = new Rectangle(-20, -30, 40, 50);
      trace("scrollRect", scrolled.scrollRect);
      addChild(scrolled);
      // cacheAsBitmap.
      var cached:Sprite = turned(card(0x55aa33), 450, 60);
      cached.cacheAsBitmap = true;
      addChild(cached);

      // Blend modes over the background.
      var multiplied:Sprite = turned(card(0xcc3333), 60, 260);
      multiplied.blendMode = BlendMode.MULTIPLY;
      addChild(multiplied);
      var added:Sprite = turned(card(0x3333cc), 160, 260);
      added.blendMode = BlendMode.ADD;
      addChild(added);
      // A blend inside a 3D card.
      var holder:Sprite = turned(card(0xeeeeee), 260, 260);
      var inside:Shape = new Shape();
      inside.graphics.beginFill(0xff0000);
      inside.graphics.drawRect(-15, -15, 30, 30);
      inside.blendMode = BlendMode.MULTIPLY;
      holder.addChild(inside);
      addChild(holder);
      // BitmapData.draw of a container with a 3D child.
      var src:Sprite = new Sprite();
      var c:Sprite = turned(card(0x3399cc), 40, 50);
      src.addChild(c);
      var bd:BitmapData = new BitmapData(80, 100, false, 0xffffff);
      bd.draw(src);
      var b:Bitmap = new Bitmap(bd);
      b.x = 410;
      b.y = 210;
      addChild(b);
    }

    private function turned(s:Sprite, x:Number, y:Number):Sprite {
      s.x = x;
      s.y = y;
      s.rotationY = 40;
      return s;
    }

    private function card(color:uint):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(color);
      s.graphics.drawRect(-30, -40, 60, 80);
      s.graphics.beginFill(0xffffff);
      s.graphics.drawRect(-25, -35, 15, 15);
      s.graphics.endFill();
      return s;
    }
  }
}
