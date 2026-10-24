package {
  import flash.display.Sprite;
  import flash.events.MouseEvent;
  import flash.external.ExternalInterface;

  // The web test's margins SWF: a 100 by 100 stage, yellow, with a red box
  // past its left edge and a green one past its right, which Flash draws in
  // showAll's margins, and a log of the presses the stage hears there.
  public class MarginsTest extends Sprite {
    private var log:Array = [];

    private function box(name:String, color:uint, x:Number, width:Number):Sprite {
      var s:Sprite = new Sprite();
      s.name = name;
      s.graphics.beginFill(color);
      s.graphics.drawRect(0, 0, width, 100);
      s.x = x;
      return s;
    }

    public function MarginsTest() {
      addChild(box("yellow", 0xffff00, 0, 100));
      addChild(box("red", 0xff0000, -50, 50));
      addChild(box("green", 0x00ff00, 100, 50));
      stage.addEventListener(MouseEvent.MOUSE_DOWN, function (e:MouseEvent):void {
        var target:String = e.target == stage ? "stage" : e.target.name;
        log.push(target + " " + e.stageX + "," + e.stageY + " " + stage.mouseX + "," + stage.mouseY);
      });
      ExternalInterface.addCallback("takeLog", function ():Array {
        var taken:Array = log;
        log = [];
        return taken;
      });
      ExternalInterface.addCallback("stageSize", function ():Array {
        return [stage.stageWidth, stage.stageHeight];
      });
    }
  }
}
