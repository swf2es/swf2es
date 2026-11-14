package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.MouseEvent;
  import flash.text.TextField;

  public class MouseWheel extends Sprite {
    public function MouseWheel() {
      var text:TextField = new TextField();
      for each (var x:int in [0, 100, 200]) {
        var s:Sprite = new Sprite();
        var art:Object = x == 200 ? new Shape() : s;
        art.graphics.beginFill(0xff00ff);
        art.graphics.drawRect(0, 0, 100, 100);
        art.x = x;
        art.name = x == 200 ? "shape" : "sprite" + (x / 100 + 1);
        addChild(art == s ? s : Shape(art));
      }

      text.name = "text";
      text.y = 100;
      text.multiline = true;
      text.text = "xxxx 1\nxxxx 2\nxxxx 3\nxxxx 4\nxxxx 5\nxxxx 6\nxxxx 7\nxxxx 8\nxxxx 9\nxxxx 10\nxxxx 11\nxxxx 12\nxxxx 13\n";
      addChild(text);
      stage.addEventListener("mouseWheel", function (e:MouseEvent):void {
        trace(e.type + " " + (e.target == stage ? "stage" : e.target.name) + " " + e.delta + " " + e.bubbles + " " + e.cancelable + " " + text.scrollV);
      });
    }
  }
}
