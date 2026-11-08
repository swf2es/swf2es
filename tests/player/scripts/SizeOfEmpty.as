package {
  import flash.display.*;

  // width and height set on what has nothing to measure (cases.ts'
  // size-of-empty): an empty Sprite, Shape or container takes a scale of
  // 0 both ways, whatever its scale and rotation were, so content drawn
  // in it later stays unseen; a filled one set to 0 wide comes back by
  // its own width.
  public class SizeOfEmpty extends Sprite {
    private function show(label:String, s:DisplayObject):void {
      trace(label, "scale", s.scaleX, s.scaleY, "size", s.width, s.height);
    }

    private function fill(s:Sprite):void {
      s.graphics.beginFill(0xff0000);
      s.graphics.drawRect(0, 0, 100, 100);
    }

    public function SizeOfEmpty() {
      var a:Sprite = new Sprite();
      addChild(a);
      a.width = 42;
      show("empty after width", a);
      a.height = 69;
      show("empty after height", a);
      fill(a);
      show("filled later", a);

      var b:Sprite = new Sprite();
      addChild(b);
      b.scaleX = 2;
      b.scaleY = 3;
      b.width = 42;
      show("pre-scaled empty after width", b);
      fill(b);
      show("pre-scaled filled later", b);

      var c:Sprite = new Sprite();
      addChild(c);
      c.rotation = 30;
      c.width = 42;
      show("rotated empty after width", c);
      fill(c);
      show("rotated filled later", c);

      var d:Sprite = new Sprite();
      addChild(d);
      fill(d);
      d.width = 0;
      show("filled width 0", d);
      d.width = 42;
      show("then width 42", d);

      var f:Sprite = new Sprite();
      addChild(f);
      f.height = 69;
      show("empty after height only", f);

      var h:Sprite = new Sprite();
      addChild(h);
      var inner:Sprite = new Sprite();
      h.addChild(inner);
      h.width = 42;
      show("empty child after width", h);

      var k:Shape = new Shape();
      addChild(k);
      k.width = 42;
      show("empty shape after width", k);
      k.scaleX = 1;
      show("empty shape scaleX back", k);

      var e:Sprite = new Sprite();
      addChild(e);
      e.width = 0;
      show("empty width 0", e);
    }
  }
}
