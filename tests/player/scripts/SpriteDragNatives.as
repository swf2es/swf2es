package {
  import flash.display.Sprite;
  import flash.geom.Rectangle;

  public class SpriteDragNatives extends Sprite {
    public function SpriteDragNatives() {
      var child:Sprite = new Sprite();
      addChild(child);
      child.startDrag(false, new Rectangle(0, 0, 10, 10));
      trace("drag started");
      child.stopDrag();
      trace("drag stopped");
    }
  }
}
