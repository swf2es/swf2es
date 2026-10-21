package {
  import flash.display.*;
  import flash.events.Event;
  import flash.geom.ColorTransform;

  public class MaskAncestors extends Sprite {
    private var parents:Array = [];
    private var masks:Array = [];
    private var targets:Array = [];
    private var frames:int = 0;

    public function MaskAncestors() {
      for (var i:int = 0; i < 6; i++) {
        var target:Shape = new Shape();
        target.graphics.beginFill(0x3060ff);
        target.graphics.drawRect(0, 0, 50, 50);
        target.x = i * 60;
        addChild(target);
        targets.push(target);

        var parent:Sprite = new Sprite();
        parent.x = i * 60;
        addChild(parent);
        parents.push(parent);
        var mask:Sprite = new Sprite();
        parent.addChild(mask);
        masks.push(mask);
        var part:Shape = new Shape();
        part.graphics.beginFill(0);
        part.graphics.drawRect(5, 5, 30, 30);
        mask.addChild(part);

        switch (i) {
          case 1:
            parent.visible = false;
            break;
          case 2:
            parent.alpha = 0;
            break;
          case 3:
            mask.visible = false;
            part.visible = false;
            break;
          case 4:
            parent.alpha = 0.25;
            break;
          case 5:
            parent.transform.colorTransform = new ColorTransform(0, 0, 0, 0, 255, 0, 0, 0);
            break;
        }
        target.mask = mask;
      }
      trace("mask ancestors");
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function step(event:Event):void {
      frames++;
      switch (frames) {
        case 2:
          for (var i:int = 0; i < parents.length; i++) {
            parents[i].x += 10;
          }
          break;
        case 3:
          for (i = 0; i < targets.length; i++) {
            targets[i].mask = null;
          }
          break;
        case 4:
          for (i = 0; i < targets.length; i++) {
            targets[i].mask = masks[i];
          }
          break;
        case 5:
          for (i = 0; i < parents.length; i++) {
            parents[i].visible = true;
            parents[i].transform.colorTransform = new ColorTransform();
          }
          break;
      }
    }
  }
}
