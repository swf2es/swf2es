package {
  import flash.display.Sprite;
  import flash.events.MouseEvent;

  public class MousePerspective extends Sprite {
    private var card:Sprite;

    public function MousePerspective() {
      var back:Sprite = new Sprite();
      back.name = "back";
      back.graphics.beginFill(0xdddddd);
      back.graphics.drawRect(0, 0, 500, 400);
      addChild(back);
      card = new Sprite();
      card.name = "card";
      card.graphics.beginFill(0x3366cc);
      card.graphics.drawRect(-60, -80, 120, 160);
      card.x = 330;
      card.y = 200;
      card.rotationY = 60;
      addChild(card);
      for each (var type:String in ["mouseMove", "mouseDown", "click"]) {
        stage.addEventListener(type, heard);
      }
    }

    private function heard(e:MouseEvent):void {
      trace(e.type, e.target.name, Math.round(e.localX) + "," + Math.round(e.localY),
        card.hitTestPoint(e.stageX, e.stageY, true), card.hitTestPoint(e.stageX, e.stageY, false));
    }
  }
}
