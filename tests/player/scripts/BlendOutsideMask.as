package {
  import flash.display.*;
  import flash.events.Event;

  // Blended sprites standing still whose children are masked by shapes outside them, which move
  // or are redrawn frame after frame: Flash draws such a blend from its children as they are
  // clipped now, as it keeps no bitmap of an object for a blend mode alone. A's child is masked by
  // a shape that moves 3 pixels a frame; B's by one redrawn a size larger each frame; C itself by
  // one that moves, which clips the blend as drawn.
  public class BlendOutsideMask extends Sprite {
    private function rect(g:Graphics, color:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):void {
      g.beginFill(color, alpha);
      g.drawRect(x, y, w, h);
      g.endFill();
    }

    private function layer(mode:String, x:Number, y:Number):Sprite {
      var s:Sprite = new Sprite();
      var back:Shape = new Shape();
      rect(back.graphics, 0xe08030, 0.8, 0, 0, 50, 36);
      s.addChild(back);
      var front:Shape = new Shape();
      rect(front.graphics, 0x3070d0, 0.7, 10, 8, 50, 36);
      s.addChild(front);
      s.blendMode = mode;
      s.x = x;
      s.y = y;
      addChild(s);
      return s;
    }

    public function BlendOutsideMask() {
      for (var i:int = 0; i < 12; i++) {
        rect(graphics, i % 2 ? 0x406080 : 0xa07040, 1, i * 20, 0, 20, 120);
      }
      rect(graphics, 0xd0d0c0, 1, 0, 50, 240, 14);

      var a:Sprite = layer("overlay", 10, 10);
      var aMask:Shape = new Shape();
      rect(aMask.graphics, 0, 1, 0, 0, 24, 60);
      aMask.x = 10;
      aMask.y = 10;
      addChild(aMask);
      a.getChildAt(1).mask = aMask;

      var b:Sprite = layer("hardlight", 90, 10);
      var bMask:Shape = new Shape();
      rect(bMask.graphics, 0, 1, 0, 0, 20, 20);
      bMask.x = 95;
      bMask.y = 15;
      addChild(bMask);
      b.getChildAt(0).mask = bMask;

      var c:Sprite = layer("overlay", 170, 60);
      var cMask:Shape = new Shape();
      rect(cMask.graphics, 0, 1, 0, 0, 30, 50);
      cMask.x = 165;
      cMask.y = 55;
      addChild(cMask);
      c.mask = cMask;

      var size:Number = 20;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        aMask.x += 3;
        size += 4;
        bMask.graphics.clear();
        rect(bMask.graphics, 0, 1, 0, 0, size, size);
        cMask.x += 4;
      });
      trace("drawn");
    }
  }
}
