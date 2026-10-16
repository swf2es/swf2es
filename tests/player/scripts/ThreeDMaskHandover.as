package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;

  // Masks of 3D cards let go of and taken by others: a card back to 2D
  // under its mask, a mask taken off one card and one moved from a card to
  // another before it in the list and back, which the card it leaves must
  // not put back on the stage. (A mask of a 3D card taken off the list
  // crashes adl.)
  public class ThreeDMaskHandover extends Sprite {
    private var n:int = 0;
    private var a:Sprite, b:Sprite, c:Sprite, d:Sprite, e:Sprite;
    private var ma:Shape, mb:Shape, mc:Shape, md:Shape, me:Shape;
    public function ThreeDMaskHandover() {
      a = card(80, 100); a.rotationY = 40; ma = rect(this, 50, 60, 40, 100); a.mask = ma;
      b = card(200, 100); b.rotationY = 40; mb = rect(this, 170, 60, 40, 100); b.mask = mb;
      c = card(320, 100); c.rotationY = 40; mc = rect(this, 290, 60, 40, 100); c.mask = mc;
      d = card(80, 300); mdd(); d.mask = md;
      e = card(200, 300); e.rotationX = 30; me = rect(this, 170, 260, 40, 100); e.mask = me;
      trace("start");
      addEventListener(Event.ENTER_FRAME, step);
    }
    private function mdd():void { md = rect(this, 50, 260, 40, 100); }
    private function step(ev:Event):void {
      n++;
      if (n == 2) {
        a.transform.matrix3D = null;
        b.mask = null;
        d.rotationY = 40;
        e.mask = null;
        b.mask = me;
      }
      if (n == 3) {
        a.z = 0;
        a.rotationY = -30;
        b.mask = null;
        e.mask = me;
      }
    }
    private function rect(parent:Sprite, x:Number, y:Number, w:Number, h:Number):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(0x00aa00, 0.5);
      s.graphics.drawRect(x, y, w, h);
      parent.addChild(s);
      return s;
    }
    private function card(x:Number, y:Number):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(0xcc3333);
      s.graphics.drawRect(-40, -60, 80, 120);
      s.x = x; s.y = y;
      addChild(s);
      return s;
    }
  }
}
